import { randomUUID, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { postgresControlPolicyRepository, sqliteControlPolicyRepository } from "./control-policy-repository.js";

const url = process.env.SYNAPSOR_TEST_POSTGRES_URL;
for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !url)(`runtime proof attestation: ${backend}`, () => {
    let pool: Pool;
    const dbs: DatabaseSync[] = [], schema = `runtime_proof_${process.pid}_${randomBytes(4).toString("hex")}`;
    beforeAll(() => { if (backend === "postgres") pool = new Pool({ connectionString: url, max: 4 }); });
    afterEach(() => { vi.restoreAllMocks(); for (const db of dbs.splice(0)) db.close(); });
    afterAll(async () => { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } });
    async function fixture() {
      const deployment = randomUUID(), db = backend === "sqlite" ? new DatabaseSync(":memory:") : undefined;
      if (db) { dbs.push(db); db.exec("PRAGMA foreign_keys = ON"); }
      const repository = db ? sqliteControlPolicyRepository(db) : postgresControlPolicyRepository(pool, schema);
      await repository.initialize();
      await repository.importDeployment({ deployment_id: deployment, project_id: deployment, migration_digest: canonicalJsonDigest(deployment), revisions: [], active: [],
        event: { event_id: "import", actor: "trusted-test-service", occurred_at: new Date().toISOString(), receipt: {} } });
      const content = { actor: { tenant_id: "acme", principal: "maya", agent_id: "replenishment", run_id: "1" }, chain_digest: canonicalJsonDigest("reviewed-chain") };
      const input = { deployment_id: deployment, proposal_id: "proposal-1", scope: { level: "principal" as const, tenant_id: "acme", principal: "maya" },
        content, content_digest: canonicalJsonDigest(content), expires_at_ms: Date.now() + 60_000, expected_epoch: 1 };
      const query = async (sql: string, values: Array<string | number> = []) => {
        if (!db) return (await pool.query(sql, values)).rows;
        return db.prepare(sql).all(Object.fromEntries(values.map((value, i) => [`$${i + 1}`, value])));
      };
      const table = backend === "postgres" ? `"${schema}"."control_policy_runtime_proofs"` : "control_policy_runtime_proofs";
      return { repository, input, query, table };
    }
    it("registers immutable scoped claims with no authority or epoch change and exact retry recovery", async () => {
      const f = await fixture();
      expect(await f.repository.runtimeProofs.register(f.input)).toBe("registered");
      expect(await f.repository.runtimeProofs.register(f.input)).toBe("existing");
      const { expected_epoch: _epoch, ...proof } = f.input;
      expect(await f.repository.runtimeProofs.get(f.input)).toEqual(proof);
      expect((await f.repository.deployment(f.input.deployment_id))!.epoch).toBe(1);
      const changed = { ...f.input.content, chain_digest: canonicalJsonDigest("another-chain") };
      await expect(f.repository.runtimeProofs.register({ ...f.input, content: changed, content_digest: canonicalJsonDigest(changed) })).rejects.toThrow("RUNTIME_PROOF_CONFLICT");
    });
    it("refuses cross-scope, deployment, digest and stale epoch access", async () => {
      const f = await fixture(); await f.repository.runtimeProofs.register(f.input);
      for (const wrong of [{ ...f.input, scope: { ...f.input.scope, tenant_id: "beta" } }, { ...f.input, deployment_id: "another" },
        { ...f.input, content_digest: canonicalJsonDigest("wrong") }]) {
        await expect(f.repository.runtimeProofs.get(wrong)).rejects.toThrow("RUNTIME_PROOF_UNAVAILABLE");
      }
      await expect(f.repository.runtimeProofs.register({ ...f.input, expected_epoch: 0 })).rejects.toThrow("POLICY_REVISION_CONFLICT");
    });
    it("enforces database-time expiration and bounded payload integrity", async () => {
      const f = await fixture();
      await expect(f.repository.runtimeProofs.register({ ...f.input, expires_at_ms: Date.now() + 1_800_000 })).rejects.toThrow("RUNTIME_PROOF_EXPIRED");
      await expect(f.repository.runtimeProofs.register({ ...f.input, content: {} })).rejects.toThrow("RUNTIME_PROOF_INTEGRITY_INVALID");
      const large = { data: "x".repeat(65_537) };
      await expect(f.repository.runtimeProofs.register({ ...f.input, content: large, content_digest: canonicalJsonDigest(large) })).rejects.toThrow("POLICY_CONTENT_TOO_LARGE");
      await f.repository.runtimeProofs.register(f.input);
      await f.query(`UPDATE ${f.table} SET expires_at_ms = 1 WHERE deployment_id = $1`, [f.input.deployment_id]);
      vi.spyOn(Date, "now").mockReturnValue(0);
      await expect(f.repository.runtimeProofs.get(f.input)).rejects.toThrow("RUNTIME_PROOF_EXPIRED");
    });
    it("detects stored-content tampering instead of trusting a matching lookup digest", async () => {
      const f = await fixture(); await f.repository.runtimeProofs.register(f.input);
      await f.query(`UPDATE ${f.table} SET content_json = '{}' WHERE deployment_id = $1`, [f.input.deployment_id]);
      await expect(f.repository.runtimeProofs.get(f.input)).rejects.toThrow("RUNTIME_PROOF_INTEGRITY_INVALID");
    });
  });
}
