import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { ProposalStore } from "./sqlite-store.js";
import { sqliteControlPolicyRepository, postgresControlPolicyRepository, type ControlPolicyKey, type ControlPolicyRepository } from "./control-policy-repository.js";
import type { ControlPolicyReviewTarget } from "./control-policy-reviews.js";

const url = process.env.SYNAPSOR_TEST_POSTGRES_URL;
for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !url)(`exact policy review: ${backend}`, () => {
    let pool: Pool;
    const schema = `policy_reviews_${process.pid}_${randomBytes(5).toString("hex")}`;
    const stores: ProposalStore[] = [], roots: string[] = [];
    const connections: DatabaseSync[] = [];
    beforeAll(async () => {
      if (backend === "postgres") { pool = new Pool({ connectionString: url, max: 6, statement_timeout: 5_000 }); }
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      for (const db of connections.splice(0)) db.close();
      for (const store of stores.splice(0)) store.close();
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
      // Yield between synchronous SQLite transactions so runner IPC can drain.
      await delay(0);
    });
    afterAll(async () => {
      if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } }
    });

    async function fixture(fullStore = false) {
      const deployment = `review_${randomBytes(8).toString("hex")}`;
      let dbPath = "";
      let sqlite: DatabaseSync;
      let policies: ControlPolicyRepository;
      const open = (path: string) => {
        const db = new DatabaseSync(path); connections.push(db);
        db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
        return db;
      };
      if (backend === "sqlite") {
        const root = mkdtempSync(join(tmpdir(), "synapsor-policy-reviews-")); roots.push(root);
        dbPath = join(root, "control.db");
        if (fullStore) {
          const store = new ProposalStore(dbPath); stores.push(store);
          sqlite = store.db; policies = store.controlPolicies;
        } else { sqlite = open(dbPath); policies = sqliteControlPolicyRepository(sqlite); }
      } else policies = postgresControlPolicyRepository(pool, schema);
      const key: ControlPolicyKey = { scope: { level: "principal", tenant_id: "acme", principal: "maya" }, kind: "delegation", name: "inventory.replenish" };
      const revision = (id: string) => ({ ...key, revision_id: id, content: { maximum: id === "v1" ? 20 : 10 },
        content_digest: canonicalJsonDigest({ maximum: id === "v1" ? 20 : 10 }), authority_digest: canonicalJsonDigest({ id }) });
      const event = (id: string) => ({ event_id: id, actor: "test-admin", occurred_at: "2026-09-07T00:00:00.000Z", receipt: { id } });
      await policies.initialize();
      await policies.importDeployment({ deployment_id: deployment, project_id: deployment, migration_digest: canonicalJsonDigest({ deployment }),
        revisions: [revision("v1")], active: [{ ...key, revision_id: "v1" }], event: event("import") });
      await policies.commit({ deployment_id: deployment, expected_epoch: 1, revisions: [revision("v2")], active: [],
        drafts: [{ ...key, revision_id: "v2" }], event: event("draft") });
      const target: ControlPolicyReviewTarget = { deployment_id: deployment, key, revision_id: "v2", expected_epoch: 2,
        operation: "activate", actor: "verified-acme-maya", session_digest: canonicalJsonDigest("verified-session"),
        summary_digest: canonicalJsonDigest({ before: 20, after: 10 }) };
      const query = async (sql: string, values: Array<string | number> = []) => {
        if (backend === "postgres") return (await pool.query(sql, values)).rows;
        return sqlite.prepare(sql).all(Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value])));
      };
      const table = (name: string) => backend === "postgres" ? `"${schema}"."control_policy_${name}"` : `"control_policy_${name}"`;
      const second = () => {
        if (backend === "postgres") return postgresControlPolicyRepository(pool, schema);
        return sqliteControlPolicyRepository(open(dbPath));
      };
      return { policies, deployment, key, revision, event, target, query, table, second, dbPath };
    }

    it("prepares without authority and atomically activates only the exact reviewed draft", async () => {
      const f = await fixture(true);
      const before = await f.policies.snapshot(f.deployment, [f.key]);
      const prepared = await f.policies.reviews.prepare(f.target);
      expect(prepared.nonce).toMatch(/^[a-zA-Z0-9_-]{43}$/u);
      expect(await f.policies.snapshot(f.deployment, [f.key])).toEqual(before);
      const records = await f.query(`SELECT * FROM ${f.table("reviews")} WHERE deployment_id = $1`, [f.deployment]);
      expect(JSON.stringify(records)).not.toContain(prepared.nonce);
      const receipt = await f.policies.reviews.confirm({ ...prepared.review, nonce: prepared.nonce });
      expect(receipt).toMatchObject({ status: "committed", epoch: 3, operation: "activate", key: f.key, revision_id: "v2", source_database_changed: false });
      expect(await f.policies.snapshot(f.deployment, [f.key])).toEqual({ epoch: 3, policies: [{ active: f.revision("v2") }] });
      expect(await f.policies.revision(f.deployment, f.key, "v1")).toEqual(f.revision("v1"));
      const recorded = await f.policies.event(f.deployment, receipt.event_id);
      expect(recorded).toMatchObject({ actor: f.target.actor, occurred_at: receipt.occurred_at, receipt: { summary_digest: f.target.summary_digest } });
      expect(JSON.stringify(recorded)).not.toContain(prepared.nonce);
    });

    it.each(["nonce", "actor", "session_digest", "summary_digest", "revision_id", "operation", "expected_epoch", "scope", "kind", "name", "deployment_id", "review_id"])("refuses altered %s without consuming review or changing authority", async (field) => {
      const f = await fixture(), prepared = await f.policies.reviews.prepare(f.target);
      const confirmation = { ...prepared.review, nonce: prepared.nonce };
      const changed = structuredClone(confirmation);
      if (field === "scope") changed.key.scope = { level: "principal", tenant_id: "beta", principal: "maya" };
      else if (field === "kind") changed.key.kind = "parent";
      else if (field === "name") changed.key.name = "inventory.other";
      else if (field === "operation") changed.operation = "revoke";
      else if (field === "expected_epoch") changed.expected_epoch = 3;
      else (changed as unknown as Record<string, unknown>)[field] = field.endsWith("digest") ? canonicalJsonDigest("other")
        : field === "nonce" ? "x".repeat(43) : "another";
      await expect(f.policies.reviews.confirm(changed)).rejects.toThrow();
      expect((await f.policies.snapshot(f.deployment, [f.key])).epoch).toBe(2);
      await expect(f.policies.reviews.confirm(confirmation)).resolves.toMatchObject({ status: "committed" });
    });

    it("does not activate a replaced draft or grant a newer revision from an older review", async () => {
      const f = await fixture(), prepared = await f.policies.reviews.prepare(f.target);
      await f.policies.commit({ deployment_id: f.deployment, expected_epoch: 2, revisions: [f.revision("v3")], active: [],
        drafts: [{ ...f.key, revision_id: "v3" }], event: f.event("replace") });
      await expect(f.policies.reviews.confirm({ ...prepared.review, nonce: prepared.nonce })).rejects.toMatchObject({ code: "POLICY_REVISION_CONFLICT" });
      expect(await f.policies.snapshot(f.deployment, [f.key])).toEqual({ epoch: 3, policies: [{ active: f.revision("v1"), draft: f.revision("v3") }] });
      await expect(f.policies.reviews.prepare({ ...f.target, expected_epoch: 3 })).rejects.toMatchObject({ code: "POLICY_REVIEW_REVISION_CHANGED" });
    });

    it("recovers a concurrent confirmation receipt and never reactivates it after revocation", async () => {
      const f = await fixture(), prepared = await f.policies.reviews.prepare(f.target);
      const confirmation = { ...prepared.review, nonce: prepared.nonce };
      const results = await Promise.all([f.policies, f.second()].map((p) => p.reviews.confirm(confirmation)));
      expect(results.map((value) => value.status).sort()).toEqual(["already_committed", "committed"]);
      expect(results[0]?.event_id).toBe(results[1]?.event_id);
      const revoke = await f.policies.reviews.prepare({ ...f.target, operation: "revoke", expected_epoch: 3 });
      await f.policies.reviews.confirm({ ...revoke.review, nonce: revoke.nonce });
      expect(await f.policies.active(f.deployment, f.key)).toBeUndefined();
      await expect(f.second().reviews.confirm(confirmation)).resolves.toMatchObject({ status: "already_committed", epoch: 3 });
      expect(await f.policies.snapshot(f.deployment, [f.key])).toEqual({ epoch: 4, policies: [{}] });
    });

    it("rolls back pointer changes and nonce consumption when event publication fails", async () => {
      const f = await fixture(), prepared = await f.policies.reviews.prepare(f.target);
      const eventId = `policy_review:${prepared.review.review_id}`;
      await f.query(`INSERT INTO ${f.table("events")} (deployment_id, epoch, event_id, actor, occurred_at, receipt_json)
        VALUES ($1, 999, $2, 'fault-injection', '2026-09-07T00:00:00.000Z', '{}')`, [f.deployment, eventId]);
      const before = await f.policies.snapshot(f.deployment, [f.key]);
      await expect(f.policies.reviews.confirm({ ...prepared.review, nonce: prepared.nonce })).rejects.toThrow();
      expect(await f.policies.snapshot(f.deployment, [f.key])).toEqual(before);
      await f.query(`DELETE FROM ${f.table("events")} WHERE deployment_id = $1 AND event_id = $2`, [f.deployment, eventId]);
      await expect(f.policies.reviews.confirm({ ...prepared.review, nonce: prepared.nonce })).resolves.toMatchObject({ status: "committed" });
    });

    it("survives repository reopen and revokes only the reviewed active revision, leaving a newer draft", async () => {
      const f = await fixture();
      const prepared = await f.policies.reviews.prepare({ ...f.target, revision_id: "v1", operation: "revoke" });
      const reopened = f.second();
      const before = await reopened.snapshot(f.deployment, [f.key]);
      await reopened.initialize();
      expect(await reopened.snapshot(f.deployment, [f.key])).toEqual(before);
      await expect(reopened.reviews.confirm({ ...prepared.review, nonce: prepared.nonce })).resolves.toMatchObject({ status: "committed" });
      expect(await f.policies.snapshot(f.deployment, [f.key])).toEqual({ epoch: 3, policies: [{ draft: f.revision("v2") }] });
    });

    it("enforces database-time expiry after waiting for another writer", async () => {
      const f = await fixture(), prepared = await f.policies.reviews.prepare({ ...f.target, ttl_ms: 200 });
      let release!: () => Promise<void>;
      if (backend === "postgres") {
        const client = await pool.connect();
        await client.query("BEGIN");
        await client.query(`UPDATE ${f.table("deployments")} SET epoch = epoch WHERE deployment_id = $1`, [f.deployment]);
        release = async () => { await client.query("ROLLBACK"); client.release(); };
      } else {
        const child = spawn(process.execPath, ["--input-type=module", "-e",
          `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]);
           db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked');
           setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, 400);`, f.dbPath], { stdio: ["ignore", "pipe", "pipe"] });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
        const exited = new Promise<void>((resolve, reject) => {
          child.once("error", (error) => { clearTimeout(timeout); reject(error); });
          child.once("exit", (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`writer child exited ${code}`)); });
        });
        await Promise.race([new Promise<void>((resolve) => child.stdout.once("data", () => resolve())), exited.then(() => { throw new Error("writer exited before locking"); })]);
        release = async () => { await exited; };
      }
      const refused = expect(f.policies.reviews.confirm({ ...prepared.review, nonce: prepared.nonce }))
        .rejects.toMatchObject({ code: "POLICY_REVIEW_EXPIRED" });
      try { if (backend === "postgres") await delay(400); }
      finally { await release(); }
      await refused;
      expect((await f.policies.snapshot(f.deployment, [f.key])).epoch).toBe(2);
      expect(await f.policies.active(f.deployment, f.key)).toEqual(f.revision("v1"));
    });

    it("bounds pending reviews without treating invalidated reviews as a permanent blocker", async () => {
      const f = await fixture();
      for (let index = 0; index < 16; index++) await f.policies.reviews.prepare(f.target);
      await expect(f.policies.reviews.prepare(f.target)).rejects.toMatchObject({ code: "POLICY_REVIEW_LIMIT" });
      await f.policies.commit({ deployment_id: f.deployment, expected_epoch: 2, revisions: [f.revision("v3")], active: [],
        drafts: [{ ...f.key, revision_id: "v3" }], event: f.event("revised") });
      await expect(f.policies.reviews.prepare({ ...f.target, expected_epoch: 3, revision_id: "v3" })).resolves.toHaveProperty("nonce");
      await expect(f.policies.reviews.prepare({ ...f.target, ttl_ms: 900_001 })).rejects.toMatchObject({ code: "POLICY_REVIEW_TTL_INVALID" });
    });

    it("uses the database clock rather than the caller's JavaScript clock", async () => {
      const f = await fixture();
      const realNow = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(0);
      const prepared = await f.policies.reviews.prepare(f.target);
      expect(prepared.review.expires_at_ms).toBeGreaterThan(realNow);
      await expect(f.policies.reviews.confirm({ ...prepared.review, nonce: prepared.nonce })).resolves.toMatchObject({ status: "committed" });
    });
  });
}
