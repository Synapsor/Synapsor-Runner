import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { sqliteControlPolicyRepository, postgresControlPolicyRepository } from "./control-policy-repository.js";
import type { EffectAdmissionTarget } from "./control-effect-admissions.js";

const url = process.env.SYNAPSOR_TEST_POSTGRES_URL;
for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !url)(`one-use effect admission: ${backend}`, () => {
    let pool: Pool;
    const roots: string[] = [], connections: DatabaseSync[] = [];
    const schema = `effect_admission_${process.pid}_${randomBytes(4).toString("hex")}`;
    beforeAll(() => { if (backend === "postgres") pool = new Pool({ connectionString: url, max: 8 }); });
    afterEach(() => { vi.restoreAllMocks(); for (const db of connections.splice(0)) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
    afterAll(async () => { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } });
    async function fixture() {
      const deployment = randomUUID(), root = backend === "sqlite" ? mkdtempSync(join(tmpdir(), "synapsor-admission-test-")) : undefined;
      if (root) roots.push(root);
      const open = () => {
        if (backend === "postgres") return { repository: postgresControlPolicyRepository(pool, schema), db: undefined };
        const db = new DatabaseSync(join(root!, "control.db")); connections.push(db); db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
        return { repository: sqliteControlPolicyRepository(db), db };
      };
      const { repository, db } = open(); await repository.initialize();
      await repository.importDeployment({ deployment_id: deployment, project_id: deployment, migration_digest: canonicalJsonDigest(deployment), revisions: [], active: [],
        event: { event_id: "import", actor: "trusted-test-operator", occurred_at: new Date().toISOString(), receipt: {} } });
      const target: EffectAdmissionTarget = { deployment_id: deployment, request_id: "exact-job", expected_epoch: 1,
        actor_digest: canonicalJsonDigest("authenticated-agent"), policy_chain_digest: canonicalJsonDigest("current-chain"), effect_digest: canonicalJsonDigest("exact-effect") };
      const account = { scope: { level: "tenant" as const, tenant_id: "acme" }, meter: "capacity", unit: "units", scale: 1, limit: 100, window_ms: 86_400_000 };
      await repository.budgets.reserve({ ...target, accounts: [{ ...account, amount: 60 }] });
      const input = { ...target, expires_at_ms: Date.now() + 60_000, budget_request_id: target.request_id };
      const prepare = () => repository.effects.prepare(input);
      const record = (dispatch_id: string, state: "unknown" | "completed" | "no_effect", proof = canonicalJsonDigest({ dispatch_id, state })) => repository.effects.record({
        ...target, dispatch_id, state, receipt_digest: proof });
      const inspect = () => repository.budgets.inspect({ deployment_id: deployment, account });
      const cancel = (dispatch_id: string) => repository.effects.cancelPrepared({ deployment_id: deployment, request_id: target.request_id, effect_digest: target.effect_digest, dispatch_id });
      const revoke = () => repository.commit({ deployment_id: deployment, expected_epoch: 1, revisions: [], active: [],
        event: { event_id: randomUUID(), actor: "authenticated-owner", occurred_at: new Date().toISOString(), receipt: { operation: "revoke" } } });
      const query = async (sql: string, values: Array<string | number> = []) => {
        if (!db) return (await pool.query(sql, values)).rows;
        return db.prepare(sql).all(Object.fromEntries(values.map((value, i) => [`$${i + 1}`, value])));
      };
      const table = backend === "postgres" ? `"${schema}"."control_policy_effect_admissions"` : "control_policy_effect_admissions";
      return { repository, target, input, prepare, record, cancel, inspect, revoke, query, table, open, account };
    }

    it("issues exactly one dispatch grant across independent executors and recovery", async () => {
      const f = await fixture(), prepared = await f.prepare();
      expect(prepared.state).toBe("prepared"); expect(prepared.nonce).toHaveLength(43);
      const saved = await f.query(`SELECT * FROM ${f.table} WHERE deployment_id = $1`, [f.target.deployment_id]);
      expect(JSON.stringify(saved)).not.toContain(prepared.nonce);
      const results = await Promise.all([f.repository, f.open().repository].map((repository) => repository.effects.dispatch({ ...f.target, nonce: prepared.nonce! })));
      expect(results.map((result) => result.status).sort()).toEqual(["authorized", "not_authorized"]);
      expect(results.find((result) => result.status === "not_authorized")!.reconciliation_required).toBe(true);
      const reopened = f.open().repository; await reopened.initialize();
      const retry = await reopened.effects.prepare(f.input);
      expect(retry).toMatchObject({ dispatch_id: prepared.dispatch_id, state: "dispatched" }); expect(retry.nonce).toBeUndefined();
      expect(await reopened.effects.dispatch({ ...f.target, nonce: prepared.nonce! })).toMatchObject({ status: "not_authorized", state: "dispatched" });
    });

    it("prepares the exact shared-budget hold and admission atomically with idempotent recovery", async () => {
      const f = await fixture(), account = { ...f.account, meter: "atomic-capacity", amount: 60 };
      const input = { ...f.target, request_id: "atomic-job", expires_at_ms: Date.now() + 60_000, budget_accounts: [account] };
      const first = await f.repository.effects.prepare(input), second = await f.open().repository.effects.prepare(input);
      expect(second.dispatch_id).toBe(first.dispatch_id); expect(second.nonce).not.toBe(first.nonce);
      expect(await f.repository.budgets.inspect({ deployment_id: f.target.deployment_id, account })).toEqual({ committed: 0, reserved: 60, available: 40 });
      await expect(f.repository.effects.prepare({ ...input, budget_accounts: [{ ...account, amount: 61 }] })).rejects.toThrow("BUDGET_REQUEST_CONFLICT");
      await expect(f.repository.effects.prepare({ ...input, budget_accounts: [{ ...account, limit: 59 }] })).rejects.toThrow("HARD_BUDGET_EXCEEDED");
      expect(await f.repository.effects.dispatch({ ...input, nonce: second.nonce! })).toMatchObject({ status: "authorized" });
      await f.repository.effects.record({ ...input, dispatch_id: second.dispatch_id, state: "completed", receipt_digest: canonicalJsonDigest("atomic source receipt") });
      expect(await f.repository.budgets.inspect({ deployment_id: f.target.deployment_id, account })).toEqual({ committed: 60, reserved: 0, available: 40 });
    });

    it("two independently connected agents cannot prepare more shared capacity than permitted", async () => {
      const f = await fixture(), account = { ...f.account, meter: "competing-capacity", amount: 60 };
      const results = await Promise.allSettled([f.repository, f.open().repository].map((repository, i) => repository.effects.prepare({
        ...f.target, request_id: `competing-${i}`, actor_digest: canonicalJsonDigest(`verified-agent-${i}`),
        expires_at_ms: Date.now() + 60_000, budget_accounts: [account] })));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(await f.repository.budgets.inspect({ deployment_id: f.target.deployment_id, account })).toEqual({ committed: 0, reserved: 60, available: 40 });
      expect(await f.query(`SELECT request_id FROM ${f.table} WHERE deployment_id = $1`, [f.target.deployment_id])).toHaveLength(1);
    });

    it("rolls back every account when a later cap or effect insertion fails, preserving old holds", async () => {
      const f = await fixture(), first = { ...f.account, meter: "first-capacity", amount: 60 }, last = { ...f.account, meter: "last-capacity", limit: 0, amount: 1 };
      const input = { ...f.target, request_id: "will-fail", expires_at_ms: Date.now() + 60_000, budget_accounts: [first, last] };
      await expect(f.repository.effects.prepare(input)).rejects.toThrow("HARD_BUDGET_EXCEEDED");
      expect(await f.repository.budgets.inspect({ deployment_id: f.target.deployment_id, account: first })).toEqual({ committed: 0, reserved: 0, available: 100 });
      if (backend === "postgres") await f.query(`ALTER TABLE ${f.table} ADD CONSTRAINT refuse_injected_effect CHECK (request_id <> 'will-fail')`);
      else await f.query(`CREATE TRIGGER refuse_injected_effect BEFORE INSERT ON ${f.table} WHEN NEW.request_id = 'will-fail' BEGIN SELECT RAISE(ABORT, 'injected effect failure'); END`);
      try {
        await expect(f.repository.effects.prepare({ ...input, budget_accounts: [first] })).rejects.toThrow();
        expect(await f.repository.budgets.inspect({ deployment_id: f.target.deployment_id, account: first })).toEqual({ committed: 0, reserved: 0, available: 100 });
        expect(await f.inspect()).toEqual({ committed: 0, reserved: 60, available: 40 });
        expect(await f.query(`SELECT request_id FROM ${f.table} WHERE deployment_id = $1`, [f.target.deployment_id])).toHaveLength(0);
      } finally {
        if (backend === "postgres") await f.query(`ALTER TABLE ${f.table} DROP CONSTRAINT refuse_injected_effect`);
        else await f.query("DROP TRIGGER refuse_injected_effect");
      }
      const recovered = await f.repository.effects.prepare({ ...input, budget_accounts: [first] });
      expect(recovered.state).toBe("prepared");
    });

    it("rejects stale epoch, conflicting units and expired preparation without leaving orphan reservations", async () => {
      const f = await fixture(), account = { ...f.account, meter: "stale-capacity", amount: 60 };
      const input = { ...f.target, request_id: "stale-job", expires_at_ms: Date.now() + 60_000, budget_accounts: [account] };
      await expect(f.repository.effects.prepare({ ...input, expires_at_ms: 1 })).rejects.toThrow("EFFECT_ADMISSION_EXPIRED");
      await expect(f.repository.effects.prepare({ ...input, budget_accounts: [{ ...f.account, amount: 1, unit: "other-units" }] })).rejects.toThrow("BUDGET_UNIT_MISMATCH");
      await f.revoke();
      await expect(f.repository.effects.prepare(input)).rejects.toThrow("POLICY_REVISION_CONFLICT");
      expect(await f.repository.budgets.inspect({ deployment_id: f.target.deployment_id, account })).toEqual({ committed: 0, reserved: 0, available: 100 });
      expect(await f.query(`SELECT request_id FROM ${f.table} WHERE deployment_id = $1`, [f.target.deployment_id])).toHaveLength(0);
    });

    it.each(["actor_digest", "policy_chain_digest", "effect_digest", "request_id", "deployment_id", "nonce"] as const)("refuses tampered %s without consuming the admission", async (field) => {
      const f = await fixture(), prepared = await f.prepare();
      const changed = { ...f.target, nonce: prepared.nonce!, [field]: field.endsWith("digest") ? canonicalJsonDigest("other") : field === "nonce" ? "x".repeat(43) : "other" };
      await expect(f.repository.effects.dispatch(changed)).rejects.toThrow();
      expect(await f.repository.effects.dispatch({ ...f.target, nonce: prepared.nonce! })).toMatchObject({ status: "authorized" });
    });

    it("blocks not-yet-admitted work after revocation without erasing completed work", async () => {
      const f = await fixture(), prepared = await f.prepare(); await f.revoke();
      await expect(f.repository.effects.dispatch({ ...f.target, nonce: prepared.nonce! })).rejects.toThrow("POLICY_REVISION_CONFLICT");
      await expect(f.record(prepared.dispatch_id, "completed")).rejects.toThrow("EFFECT_RECEIPT_CONFLICT");
      expect(await f.cancel(prepared.dispatch_id)).toMatchObject({ state: "no_effect", accounting_pending: false });
      expect(await f.inspect()).toMatchObject({ reserved: 0, available: 100 });
      const other = await fixture(), admitted = await other.prepare();
      await other.repository.effects.dispatch({ ...other.target, nonce: admitted.nonce! }); await other.revoke();
      expect(await other.record(admitted.dispatch_id, "completed")).toMatchObject({ state: "completed", accounting_pending: false });
      expect(await other.inspect()).toEqual({ committed: 60, reserved: 0, available: 40 });
    });

    it("allows nonce recovery before dispatch without extending lifetime or retaining the old nonce", async () => {
      const f = await fixture(), first = await f.prepare(), second = await f.prepare();
      expect(second.dispatch_id).toBe(first.dispatch_id); expect(second.nonce).not.toBe(first.nonce);
      expect(second.expires_at_ms).toBe(first.expires_at_ms);
      await expect(f.repository.effects.dispatch({ ...f.target, nonce: first.nonce! })).rejects.toThrow("EFFECT_ADMISSION_INVALID");
      await expect(f.repository.effects.prepare({ ...f.input, expires_at_ms: f.input.expires_at_ms + 1 })).rejects.toThrow("EFFECT_ADMISSION_CONFLICT");
      expect(await f.repository.effects.dispatch({ ...f.target, nonce: second.nonce! })).toMatchObject({ status: "authorized" });
    });

    it("retains unknown work and cannot release or dispatch a duplicate after terminal completion", async () => {
      const f = await fixture(), prepared = await f.prepare(); await f.repository.effects.dispatch({ ...f.target, nonce: prepared.nonce! });
      await expect(f.cancel(prepared.dispatch_id)).rejects.toThrow("EFFECT_ALREADY_DISPATCHED");
      expect(await f.record(prepared.dispatch_id, "unknown")).toMatchObject({ state: "unknown", accounting_pending: false });
      expect(await f.inspect()).toMatchObject({ reserved: 60, committed: 0 });
      expect(await f.prepare()).not.toHaveProperty("nonce");
      expect(await f.record(prepared.dispatch_id, "completed")).toMatchObject({ state: "completed", accounting_pending: false });
      expect(await f.record(prepared.dispatch_id, "completed")).toMatchObject({ accounting_pending: false });
      await expect(f.record(prepared.dispatch_id, "no_effect")).rejects.toThrow("EFFECT_RECEIPT_CONFLICT");
      expect(await f.repository.effects.dispatch({ ...f.target, nonce: prepared.nonce! })).toMatchObject({ status: "not_authorized", state: "completed", reconciliation_required: false });
    });

    it("recovers accounting after a durable receipt without freeing uncertain capacity", async () => {
      const f = await fixture(), prepared = await f.prepare(); await f.repository.effects.dispatch({ ...f.target, nonce: prepared.nonce! });
      vi.spyOn(f.repository.budgets, "settle").mockRejectedValueOnce(new Error("simulated unavailable accounting"));
      expect(await f.record(prepared.dispatch_id, "completed")).toMatchObject({ state: "completed", accounting_pending: true });
      expect(await f.inspect()).toEqual({ committed: 0, reserved: 60, available: 40 });
      expect(await f.record(prepared.dispatch_id, "completed")).toMatchObject({ state: "completed", accounting_pending: false });
      expect(await f.inspect()).toEqual({ committed: 60, reserved: 0, available: 40 });
    });

    it("binds one budget reservation to only one execution identity", async () => {
      const f = await fixture(); await f.prepare();
      await expect(f.repository.effects.prepare({ ...f.input, request_id: "another-effect" })).rejects.toThrow();
      await expect(f.repository.effects.prepare({ ...f.input, request_id: "unreserved", budget_request_id: "missing" })).rejects.toThrow("EFFECT_BUDGET_NOT_RESERVED");
      await expect(f.repository.effects.prepare({ ...f.input, request_id: "mismatched-effect", effect_digest: canonicalJsonDigest("another-effect") })).rejects.toThrow("EFFECT_BUDGET_NOT_RESERVED");
      expect(await f.inspect()).toMatchObject({ reserved: 60 });
    });

    it("uses the database clock and refuses expired dispatch without consuming it", async () => {
      const f = await fixture(), prepared = await f.prepare();
      await f.query(`UPDATE ${f.table} SET expires_at_ms = 1 WHERE deployment_id = $1`, [f.target.deployment_id]);
      vi.spyOn(Date, "now").mockReturnValue(0);
      await expect(f.repository.effects.dispatch({ ...f.target, nonce: prepared.nonce! })).rejects.toThrow("EFFECT_ADMISSION_EXPIRED");
      const rows = await f.query(`SELECT state FROM ${f.table} WHERE deployment_id = $1`, [f.target.deployment_id]);
      expect(rows[0]!.state).toBe("prepared");
      expect(await f.inspect()).toMatchObject({ reserved: 60 });
    });

    it("rejects prepared admissions with unreviewably long lifetimes", async () => {
      const f = await fixture();
      await expect(f.repository.effects.prepare({ ...f.input, expires_at_ms: Date.now() + 1_800_000 })).rejects.toThrow("EFFECT_ADMISSION_EXPIRED");
      expect(await f.prepare()).toHaveProperty("nonce");
    });

    it("cancels before releasing capacity so racing dispatch never uses a freed reservation", async () => {
      const f = await fixture(), prepared = await f.prepare();
      const results = await Promise.allSettled([f.cancel(prepared.dispatch_id),
        f.open().repository.effects.dispatch({ ...f.target, nonce: prepared.nonce! })]);
      const cancellation = results[0]!, dispatch = results[1]!;
      if (cancellation.status === "fulfilled") {
        expect(await f.inspect()).toMatchObject({ available: 100 });
        if (dispatch.status === "fulfilled") expect(dispatch.value).toMatchObject({ status: "not_authorized", state: "no_effect", reconciliation_required: false });
      } else {
        expect(cancellation.reason).toMatchObject({ code: "EFFECT_ALREADY_DISPATCHED" });
        expect(dispatch.status).toBe("fulfilled");
        expect(await f.inspect()).toMatchObject({ reserved: 60, available: 40 });
      }
      expect(await f.repository.effects.dispatch({ ...f.target, nonce: prepared.nonce! })).toMatchObject({ status: "not_authorized" });
    });
  });
}
