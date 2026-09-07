import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { sqliteControlPolicyRepository, postgresControlPolicyRepository } from "./control-policy-repository.js";
import type { HardBudgetLimit, HardBudgetReservation } from "./control-hard-budgets.js";

const url = process.env.SYNAPSOR_TEST_POSTGRES_URL;
for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !url)(`shared hard budgets: ${backend}`, () => {
    let pool: Pool;
    const roots: string[] = [], connections: DatabaseSync[] = [];
    const schema = `hard_budget_${process.pid}_${randomBytes(5).toString("hex")}`;
    beforeAll(() => { if (backend === "postgres") pool = new Pool({ connectionString: url, max: 8 }); });
    afterEach(() => {
      vi.restoreAllMocks(); for (const db of connections.splice(0)) db.close();
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });
    afterAll(async () => { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } });
    async function fixture() {
      const deployment = randomUUID(), root = backend === "sqlite" ? mkdtempSync(join(tmpdir(), "synapsor-budget-test-")) : undefined;
      if (root) roots.push(root);
      const path = root ? join(root, "control.db") : "";
      const open = () => {
        if (backend === "postgres") return { policies: postgresControlPolicyRepository(pool, schema), db: undefined };
        const db = new DatabaseSync(path); connections.push(db); db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
        return { policies: sqliteControlPolicyRepository(db), db };
      };
      const { policies, db } = open();
      await policies.initialize();
      await policies.importDeployment({ deployment_id: deployment, project_id: deployment, migration_digest: canonicalJsonDigest(deployment),
        revisions: [], active: [], event: { event_id: "import", actor: "trusted-test-operator", occurred_at: new Date().toISOString(), receipt: {} } });
      const account: HardBudgetLimit = { scope: { level: "principal", tenant_id: "acme", principal: "maya" }, meter: "stock_units",
        unit: "items", scale: 1, limit: 100, window_ms: 86_400_000 };
      const request = (id: string, amount = 60, selected = account): HardBudgetReservation => ({ deployment_id: deployment,
        request_id: id, expected_epoch: 1, policy_chain_digest: canonicalJsonDigest("reviewed-chain"), effect_digest: canonicalJsonDigest({ id, exact_effect: true }),
        accounts: [{ ...selected, amount }] });
      const settle = (id: string, state: "unknown" | "released" | "committed", proof = canonicalJsonDigest({ id, state })) => policies.budgets.settle({
        deployment_id: deployment, request_id: id, effect_digest: request(id).effect_digest, state, receipt_digest: proof });
      const inspect = (selected = account) => policies.budgets.inspect({ deployment_id: deployment, account: selected });
      const bumpEpoch = () => policies.commit({ deployment_id: deployment, expected_epoch: 1, revisions: [], active: [],
        event: { event_id: randomUUID(), actor: "trusted-test-operator", occurred_at: new Date().toISOString(), receipt: { operation: "policy_edit" } } });
      const query = async (sql: string, values: Array<string | number> = []) => {
        if (!db) return (await pool.query(sql, values)).rows;
        return db.prepare(sql).all(Object.fromEntries(values.map((value, i) => [`$${i + 1}`, value])));
      };
      const table = (name: string) => backend === "postgres" ? `"${schema}"."control_policy_budget_${name}"` : `"control_policy_budget_${name}"`;
      return { policies, deployment, account, request, settle, inspect, bumpEpoch, query, table, open };
    }

    it("serializes independent agents against one shared allowance without authorizing execution", async () => {
      const f = await fixture(), other = f.open().policies;
      const results = await Promise.allSettled([f.policies.budgets.reserve(f.request("agent-a-run")), other.budgets.reserve(f.request("agent-b-run"))]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      expect(refused.reason).toMatchObject({ code: "HARD_BUDGET_EXCEEDED" });
      const accepted = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<unknown>;
      expect(accepted.value).toMatchObject({ state: "reserved", execution_authorized: false });
      expect(await f.inspect()).toEqual({ committed: 0, reserved: 60, available: 40 });
      expect((await f.policies.deployment(f.deployment))!.epoch).toBe(1);
    });

    it("recovers identical concurrent retries exactly once and refuses changed effect or accounts", async () => {
      const f = await fixture(), request = f.request("same-request");
      const results = await Promise.all([f.policies.budgets.reserve(request), f.open().policies.budgets.reserve(request)]);
      expect(results.map((result) => result.status).sort()).toEqual(["existing", "reserved"]);
      await expect(f.policies.budgets.reserve({ ...request, effect_digest: canonicalJsonDigest("changed") })).rejects.toThrow("BUDGET_REQUEST_CONFLICT");
      await expect(f.policies.budgets.reserve({ ...request, accounts: [{ ...request.accounts[0]!, amount: 1 }] })).rejects.toThrow("BUDGET_REQUEST_CONFLICT");
      expect(await f.inspect()).toMatchObject({ reserved: 60 });
      await f.settle("same-request", "committed");
      expect(await f.policies.budgets.reserve(request)).toMatchObject({ status: "existing", state: "committed", execution_authorized: false });
      expect(await f.inspect()).toEqual({ committed: 60, reserved: 0, available: 40 });
    });

    it("preserves consumption through policy edits, new agent runs, reduced limits and repository reopen", async () => {
      const f = await fixture();
      await f.policies.budgets.reserve(f.request("first")); await f.settle("first", "committed");
      await f.bumpEpoch();
      const reopened = f.open().policies; await reopened.initialize();
      const next = { ...f.request("new-agent"), expected_epoch: 2, policy_chain_digest: canonicalJsonDigest("new-policy") };
      await expect(reopened.budgets.reserve(next)).rejects.toThrow("HARD_BUDGET_EXCEEDED");
      expect(await f.inspect({ ...f.account, limit: 50 })).toEqual({ committed: 60, reserved: 0, available: 0 });
      await expect(reopened.budgets.reserve({ ...next, accounts: [{ ...f.account, limit: 50, amount: 1 }] })).rejects.toThrow("HARD_BUDGET_EXCEEDED");
      expect(await reopened.budgets.reserve({ ...next, accounts: [{ ...f.account, amount: 40 }] })).toMatchObject({ state: "reserved" });
      expect(await f.inspect()).toEqual({ committed: 60, reserved: 40, available: 0 });
    });

    it("reserves all account layers atomically or none, including account creation", async () => {
      const f = await fixture();
      const request = f.request("two-layers", 20);
      request.accounts.push({ ...f.account, scope: { level: "tenant", tenant_id: "acme" }, limit: 10, amount: 20 });
      await expect(f.policies.budgets.reserve(request)).rejects.toThrow("HARD_BUDGET_EXCEEDED");
      expect(await f.inspect()).toEqual({ committed: 0, reserved: 0, available: 100 });
      expect(await f.query(`SELECT * FROM ${f.table("requests")} WHERE deployment_id = $1`, [f.deployment])).toEqual([]);
      expect(await f.query(`SELECT * FROM ${f.table("accounts")} WHERE deployment_id = $1`, [f.deployment])).toEqual([]);
      request.accounts[1]!.limit = 100;
      await f.policies.budgets.reserve(request);
      await f.settle("two-layers", "committed");
      expect(await f.inspect()).toEqual({ committed: 20, reserved: 0, available: 80 });
      expect(await f.inspect(request.accounts[1]!)).toEqual({ committed: 20, reserved: 0, available: 80 });
    });

    it("does not reset committed usage when a policy shortens its rolling window", async () => {
      const f = await fixture(); await f.policies.budgets.reserve(f.request("daily", 100)); await f.settle("daily", "committed");
      await f.bumpEpoch();
      const shorter = { ...f.account, window_ms: 1 };
      expect(await f.inspect(shorter)).toEqual({ committed: 100, reserved: 0, available: 0 });
      await expect(f.policies.budgets.reserve({ ...f.request("short-window", 100, shorter), expected_epoch: 2 })).rejects.toThrow("HARD_BUDGET_EXCEEDED");
      await f.query(`UPDATE ${f.table("entries")} SET settled_at_ms = 1 WHERE deployment_id = $1`, [f.deployment]);
      expect(await f.inspect(shorter)).toEqual({ committed: 0, reserved: 0, available: 100 });
    });

    it("keeps unknown outcomes reserved indefinitely until authoritative reconciliation", async () => {
      const f = await fixture(); await f.policies.budgets.reserve(f.request("uncertain")); await f.settle("uncertain", "unknown");
      await f.query(`UPDATE ${f.table("requests")} SET reserved_at_ms = 1 WHERE deployment_id = $1`, [f.deployment]);
      await f.query(`UPDATE ${f.table("entries")} SET settled_at_ms = 1 WHERE deployment_id = $1`, [f.deployment]);
      expect(await f.inspect()).toEqual({ committed: 0, reserved: 60, available: 40 });
      await expect(f.policies.budgets.reserve(f.request("retry-new-id"))).rejects.toThrow("HARD_BUDGET_EXCEEDED");
      await f.bumpEpoch();
      await expect(f.settle("uncertain", "committed")).resolves.toMatchObject({ state: "committed" });
      expect(await f.inspect()).toEqual({ committed: 60, reserved: 0, available: 40 });
    });

    it("releases only proven no-effect work and never rewrites a terminal receipt", async () => {
      const f = await fixture(); await f.policies.budgets.reserve(f.request("canceled"));
      const result = await f.settle("canceled", "released"); expect(result.state).toBe("released");
      expect(await f.settle("canceled", "released")).toMatchObject({ status: "existing", state: "released" });
      await expect(f.settle("canceled", "committed")).rejects.toThrow("BUDGET_SETTLEMENT_CONFLICT");
      await expect(f.settle("canceled", "released", canonicalJsonDigest("different-receipt"))).rejects.toThrow("BUDGET_SETTLEMENT_CONFLICT");
      expect(await f.inspect()).toEqual({ committed: 0, reserved: 0, available: 100 });
      expect(await f.policies.budgets.reserve(f.request("canceled"))).toMatchObject({ state: "released", status: "existing" });
      await f.policies.budgets.reserve(f.request("another", 100)); await f.settle("another", "committed");
      await expect(f.settle("another", "released")).rejects.toThrow("BUDGET_SETTLEMENT_CONFLICT");
      expect(await f.inspect()).toEqual({ committed: 100, reserved: 0, available: 0 });
    });

    it("separates equal principal names across tenants and fixes units for an account", async () => {
      const f = await fixture(), beta = { ...f.account, scope: { level: "principal" as const, tenant_id: "beta", principal: "maya" } };
      await f.policies.budgets.reserve(f.request("acme", 100)); await f.policies.budgets.reserve(f.request("beta", 100, beta));
      expect(await f.inspect(beta)).toEqual({ committed: 0, reserved: 100, available: 0 });
      await expect(f.policies.budgets.reserve(f.request("wrong-unit", 1, { ...f.account, unit: "usd" }))).rejects.toThrow("BUDGET_UNIT_MISMATCH");
      await expect(f.inspect({ ...f.account, scale: 100 })).rejects.toThrow("BUDGET_UNIT_MISMATCH");
    });

    it("uses database settlement time for rolling usage, not caller wall-clock time", async () => {
      const f = await fixture(); await f.policies.budgets.reserve(f.request("finished")); await f.settle("finished", "committed");
      vi.spyOn(Date, "now").mockReturnValue(0);
      expect(await f.inspect()).toMatchObject({ committed: 60 });
      await f.query(`UPDATE ${f.table("entries")} SET settled_at_ms = 1 WHERE deployment_id = $1`, [f.deployment]);
      expect(await f.inspect()).toEqual({ committed: 0, reserved: 0, available: 100 });
    });

    it("refuses stale policy epochs and invalid amounts before reservation", async () => {
      const f = await fixture(); await f.bumpEpoch();
      await expect(f.policies.budgets.reserve(f.request("stale"))).rejects.toThrow("POLICY_REVISION_CONFLICT");
      for (const amount of [0, -1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(f.policies.budgets.reserve(f.request("invalid", amount))).rejects.toThrow("BUDGET_VALUE_INVALID");
      }
      const duplicate = f.request("duplicate"); duplicate.accounts.push(duplicate.accounts[0]!);
      await expect(f.policies.budgets.reserve(duplicate)).rejects.toThrow("BUDGET_DUPLICATE_ACCOUNT");
      expect(await f.inspect()).toEqual({ committed: 0, reserved: 0, available: 100 });
    });

    it("rolls back all settlement work if the receipt cannot be recorded", async () => {
      const f = await fixture(); await f.policies.budgets.reserve(f.request("fault"));
      const proof = canonicalJsonDigest({ id: "fault", state: "committed" });
      await f.query(`INSERT INTO ${f.table("receipts")} (deployment_id, request_id, receipt_digest, state, recorded_at_ms)
        VALUES ($1, $2, $3, 'unknown', 1)`, [f.deployment, "fault", proof]);
      await expect(f.settle("fault", "committed")).rejects.toThrow();
      expect(await f.inspect()).toEqual({ committed: 0, reserved: 60, available: 40 });
      await f.query(`DELETE FROM ${f.table("receipts")} WHERE deployment_id = $1`, [f.deployment]);
      await expect(f.settle("fault", "committed")).resolves.toMatchObject({ state: "committed" });
    });
  });
}
