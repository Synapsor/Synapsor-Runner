import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { compileActionRule } from "../../action-rules/src/compile.js";
import { evaluateActionRule } from "../../action-rules/src/evaluate.js";
import { loadActionRuleFacts } from "../../action-rules/src/fact-loader.js";
import { completeCollectionFixture } from "../../action-rules/src/testing/complete-collection-fixture.js";
import { bindPostgresActionRuleScope, createPostgresActionRuleFactLoader, postgresReceiptMigration } from "./index.js";

describe.skipIf(process.env.SYNAPSOR_TEST_COMPLETE_COLLECTIONS_LIVE !== "1")("owned PostgreSQL complete-collection concurrency", () => {
  const name = `synapsor-collection-pg-${randomUUID().slice(0, 8)}`;
  const f = completeCollectionFixture("postgres");
  const compiled = compileActionRule(f);
  const scope = { tenantId: "t1", principal: "p1", tenantSetting: "synapsor.tenant_id", principalSetting: "synapsor.principal" };
  const rls = "tenant_id::text = nullif(current_setting('synapsor.tenant_id', true), '') AND principal_id::text = nullif(current_setting('synapsor.principal', true), '')";
  let admin: Pool;
  let writer: Pool;
  let reader: Pool;
  let started = false;
  beforeAll(async () => {
    execFileSync("docker", ["run", "--rm", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=fixture", "-e", "POSTGRES_DB=collections", "-p", "127.0.0.1::5432", "postgres:17"], { stdio: "pipe" });
    started = true;
    const port = Number(execFileSync("docker", ["port", name, "5432/tcp"], { encoding: "utf8" }).trim().split(":").at(-1));
    const config = { host: "127.0.0.1", port, database: "collections", user: "postgres", password: "fixture", connectionTimeoutMillis: 1000 };
    admin = new Pool(config);
    for (let attempt = 0; ; attempt++) {
      try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 60) throw error; await sleep(250); }
    }
    await admin.query(`CREATE SCHEMA collections;
      CREATE ROLE collection_reader LOGIN PASSWORD 'fixture'; CREATE ROLE collection_writer LOGIN PASSWORD 'fixture';
      CREATE TABLE collections.customers (customer_id varchar(64) PRIMARY KEY, tenant_id varchar(64) NOT NULL, principal_id varchar(64) NOT NULL,
        state varchar(16) NOT NULL, version integer NOT NULL, UNIQUE (tenant_id, principal_id, customer_id));
      CREATE TABLE collections.holds (hold_id varchar(64) PRIMARY KEY, tenant_id varchar(64) NOT NULL, principal_id varchar(64) NOT NULL,
        customer_id varchar(64) NOT NULL, state varchar(16) NOT NULL,
        CONSTRAINT holds_customer_fk FOREIGN KEY (tenant_id, principal_id, customer_id) REFERENCES collections.customers (tenant_id, principal_id, customer_id));
      GRANT USAGE ON SCHEMA collections TO collection_reader, collection_writer;
      GRANT SELECT ON ALL TABLES IN SCHEMA collections TO collection_reader, collection_writer;
      GRANT UPDATE (state, version) ON collections.customers TO collection_writer;
      GRANT UPDATE (hold_id) ON collections.holds TO collection_writer;`);
    for (const table of ["customers", "holds"]) await admin.query(`ALTER TABLE collections.${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE collections.${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY read_customer ON collections.${table} FOR SELECT TO collection_reader, collection_writer USING (${rls});
      CREATE POLICY lock_customer ON collections.${table} FOR UPDATE TO collection_writer USING (${rls}) WITH CHECK (${rls});`);
    writer = new Pool({ ...config, user: "collection_writer" });
    reader = new Pool({ ...config, user: "collection_reader" });
  }, 60_000);
  afterAll(async () => {
    await reader?.end(); await writer?.end(); await admin?.end();
    if (started) execFileSync("docker", ["rm", "-f", name], { stdio: "pipe" });
  });
  beforeEach(async () => {
    await admin.query(`ALTER POLICY read_customer ON collections.holds USING (${rls}); ALTER POLICY lock_customer ON collections.holds USING (${rls}) WITH CHECK (${rls});
      TRUNCATE collections.holds, collections.customers;
      INSERT INTO collections.customers VALUES ('c1','t1','p1','active',1), ('c2','t1','p2','active',1), ('c3','t2','p1','active',1);`);
  });
  async function begin(pool = writer) {
    const client = await pool.connect();
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await bindPostgresActionRuleScope(client, scope);
    return client;
  }
  const load = (client: PoolClient, mode: "proposal_snapshot" | "transaction_reverify" = "transaction_reverify") => loadActionRuleFacts({
    compiled, subjects: f.subjects, trusted: f.facts.trusted, mode, adapter: createPostgresActionRuleFactLoader(client, scope),
  });
  async function finish(client: PoolClient) { try { await client.query("ROLLBACK"); } finally { client.release(); } }
  it("accepts an empty collection through the SELECT-only reader without provisioning a writer", async () => {
    const client = await begin(reader);
    try {
      const loaded = await load(client, "proposal_snapshot");
      expect(evaluateActionRule({ compiled, facts: loaded.facts, proposal_id: "p1" }).result).toBe("eligible");
      expect(loaded.queries.every(query => query.lock === "none")).toBe(true);
    } finally { await finish(client); }
  });
  it.each(["insert", "reactivate", "delete", "retarget", "policy_change"] as const)("blocks a concurrent %s until the verification transaction ends", async operation => {
    if (operation === "reactivate" || operation === "delete") await admin.query("INSERT INTO collections.holds VALUES ('h1','t1','p1','c1','released')");
    if (operation === "retarget") await admin.query("INSERT INTO collections.holds VALUES ('h1','t1','p2','c2','active')");
    const client = await begin();
    const other = await admin.connect();
    let pending: Promise<unknown> | undefined;
    try {
      const loaded = await load(client);
      expect(evaluateActionRule({ compiled, facts: loaded.facts, proposal_id: "p1" }).result).toBe("eligible");
      expect((await client.query("SELECT mode FROM pg_locks WHERE pid=pg_backend_pid() AND relation='collections.holds'::regclass")).rows).toContainEqual({ mode: "RowShareLock" });
      await other.query("BEGIN");
      await other.query("SET LOCAL lock_timeout = '1500ms'");
      let completed = false;
      pending = other.query(operation === "insert" ? "INSERT INTO collections.holds VALUES ('h1','t1','p1','c1','active')"
        : operation === "policy_change" ? `ALTER POLICY read_customer ON collections.holds USING ((${rls}) AND state='released')`
          : operation === "delete" ? "DELETE FROM collections.holds WHERE hold_id='h1'"
          : operation === "retarget" ? "UPDATE collections.holds SET principal_id='p1', customer_id='c1' WHERE hold_id='h1'"
          : "UPDATE collections.holds SET state='active' WHERE hold_id='h1'")
        .then(() => { completed = true; }, error => { throw error; });
      // Attach rejection immediately while the independent lock-observation query runs.
      void pending.catch(() => {});
      const pid = (other as unknown as { processID: number }).processID;
      let blocked = false;
      for (let n = 0; n < 40; n++) {
        const activity = await admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid]);
        if (activity.rows[0]?.wait_event_type === "Lock") { blocked = true; break; }
        await sleep(20);
      }
      expect(blocked).toBe(true); expect(completed).toBe(false);
      await client.query("COMMIT");
      await pending;
      expect(completed).toBe(true);
    } finally { await finish(client); await pending?.catch(() => {}); await finish(other); }
  });
  it("sees a newly committed hold when verification waited for the parent", async () => {
    const blocker = await admin.connect();
    const client = await begin();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT customer_id FROM collections.customers WHERE customer_id='c1' FOR UPDATE");
      const loading = load(client);
      void loading.catch(() => {});
      await blocker.query("INSERT INTO collections.holds VALUES ('h1','t1','p1','c1','active')");
      await blocker.query("COMMIT");
      const result = await loading;
      expect(evaluateActionRule({ compiled, facts: result.facts, proposal_id: "p1" }).result).toBe("ineligible");
    } finally { await finish(client); await finish(blocker); }
  });
  it.each(["read_customer", "lock_customer"])("refuses hidden rows in %s rather than interpreting them as absence", async policy => {
    await admin.query("INSERT INTO collections.holds VALUES ('h1','t1','p1','c1','active')");
    await admin.query(`ALTER POLICY ${policy} ON collections.holds USING ((${rls}) AND state='released')`);
    const client = await begin();
    try { await expect(load(client)).rejects.toThrow("cannot prove"); } finally { await finish(client); }
  });
  it("retains every key component and never mistakes another customer's hold for this customer's hold", async () => {
    await admin.query("INSERT INTO collections.holds VALUES ('other','t1','p2','c2','active'), ('other_tenant','t2','p1','c3','active')");
    const client = await begin();
    try {
      const result = await load(client);
      expect(result.facts.bindings.holds?.rows).toEqual([]);
      expect(result.queries[1]?.predicates[0]).toMatchObject({ operation: "tuple_in", columns: ["tenant_id", "principal_id", "customer_id"], tuples: [["t1", "p1", "c1"]] });
    } finally { await finish(client); }
  });
  it("creates and upgrades the qualified receipt table with the default search path", async () => {
    const sql = postgresReceiptMigration.replaceAll("synapsor_writeback_receipts", '"collections"."receipts"');
    await admin.query(sql); await admin.query(sql);
    expect((await admin.query("SELECT to_regclass('collections.receipts') AS qualified, to_regclass('public.synapsor_writeback_receipts') AS stray")).rows[0]).toEqual({ qualified: "collections.receipts", stray: null });
  });
  it("recomputes filtered totals after preparation and refuses a newly exceeded cap", async () => {
    await admin.query("ALTER TABLE collections.holds ADD COLUMN credits integer NOT NULL DEFAULT 0");
    const totals = completeCollectionFixture("postgres");
    const type = { kind: "integer" as const, unit: "credits" };
    totals.catalog.resources[1]!.fields.push({ name: "credits", type, nullable: false });
    totals.rule.require = { kind: "compare", operator: "lte",
      left: { kind: "aggregate", operation: "sum", binding: "holds", field: "credits", where: { kind: "compare", operator: "eq",
        left: { kind: "field", binding: "holds", field: "state" }, right: { kind: "literal", value: "active", value_type: { kind: "string", max_length: 16, comparison: "exact" } } } },
      right: { kind: "literal", value: 16, value_type: type } };
    const totalRule = compileActionRule(totals);
    const totalLoad = async (client: PoolClient, mode: "proposal_snapshot" | "transaction_reverify") => loadActionRuleFacts({
      compiled: totalRule, subjects: totals.subjects, trusted: totals.facts.trusted, mode, adapter: createPostgresActionRuleFactLoader(client, scope) });
    try {
      await admin.query("INSERT INTO collections.holds VALUES ('h1','t1','p1','c1','active',13), ('h2','t1','p1','c1','released',4)");
      const prepared = await begin(reader);
      try { expect(evaluateActionRule({ compiled: totalRule, facts: (await totalLoad(prepared, "proposal_snapshot")).facts, proposal_id: "total" }).result).toBe("eligible"); }
      finally { await finish(prepared); }
      await admin.query("UPDATE collections.holds SET state='active' WHERE hold_id='h2'");
      const execution = await begin();
      try { expect(evaluateActionRule({ compiled: totalRule, facts: (await totalLoad(execution, "transaction_reverify")).facts, proposal_id: "total" }).result).toBe("ineligible"); }
      finally { await finish(execution); }
      expect((await admin.query("SELECT state, version FROM collections.customers WHERE customer_id='c1'")).rows[0]).toEqual({ state: "active", version: 1 });
    } finally { await admin.query("ALTER TABLE collections.holds DROP COLUMN credits"); }
  });
  it("refuses deferred or removed foreign-key protection after drafting", async () => {
    await admin.query("ALTER TABLE collections.holds ALTER CONSTRAINT holds_customer_fk DEFERRABLE INITIALLY DEFERRED");
    const client = await begin();
    try { await expect(load(client)).rejects.toThrow("unique target proof changed"); }
    finally { await finish(client); await admin.query("ALTER TABLE collections.holds ALTER CONSTRAINT holds_customer_fk NOT DEFERRABLE"); }
  });
});
