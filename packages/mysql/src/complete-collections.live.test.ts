import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import mysql, { type Connection } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compileActionRule } from "../../action-rules/src/compile.js";
import { evaluateActionRule } from "../../action-rules/src/evaluate.js";
import { loadActionRuleFacts } from "../../action-rules/src/fact-loader.js";
import { completeCollectionFixture } from "../../action-rules/src/testing/complete-collection-fixture.js";
import { createMysqlActionRuleFactLoader } from "./index.js";

describe.skipIf(process.env.SYNAPSOR_TEST_COMPLETE_COLLECTIONS_LIVE !== "1")("owned MySQL complete-collection concurrency", () => {
  const name = `synapsor-collection-mysql-${randomUUID().slice(0, 8)}`;
  const f = completeCollectionFixture("mysql");
  const compiled = compileActionRule(f);
  let config: { host: string; port: number; database: string; user: string; password: string; connectTimeout: number };
  let admin: Connection;
  let started = false;
  beforeAll(async () => {
    execFileSync("docker", ["run", "--rm", "-d", "--name", name, "-e", "MYSQL_ROOT_PASSWORD=fixture", "-e", "MYSQL_DATABASE=collections", "-e", "MYSQL_ROOT_HOST=%", "-p", "127.0.0.1::3306", "mysql:8.4"], { stdio: "pipe" });
    started = true;
    const port = Number(execFileSync("docker", ["port", name, "3306/tcp"], { encoding: "utf8" }).trim().split(":").at(-1));
    config = { host: "127.0.0.1", port, database: "collections", user: "root", password: "fixture", connectTimeout: 1000 };
    for (let attempt = 0; ; attempt++) {
      try { admin = await mysql.createConnection(config); await admin.query("SELECT 1"); break; } catch (error) { await admin?.end().catch(() => {}); if (attempt === 120) throw error; await sleep(500); }
    }
    await admin.query(`CREATE TABLE customers (customer_id varchar(64) PRIMARY KEY, tenant_id varchar(64) NOT NULL, principal_id varchar(64) NOT NULL,
      state varchar(16) NOT NULL, version integer NOT NULL, UNIQUE (tenant_id, principal_id, customer_id)) ENGINE=InnoDB COLLATE=utf8mb4_bin`);
    await admin.query(`CREATE TABLE holds (hold_id varchar(64) PRIMARY KEY, tenant_id varchar(64) NOT NULL, principal_id varchar(64) NOT NULL,
      customer_id varchar(64) NOT NULL, state varchar(16) NOT NULL,
      CONSTRAINT holds_customer_fk FOREIGN KEY (tenant_id, principal_id, customer_id) REFERENCES customers (tenant_id, principal_id, customer_id)) ENGINE=InnoDB COLLATE=utf8mb4_bin`);
    await admin.query("CREATE USER 'collection_writer'@'%' IDENTIFIED BY 'fixture'");
    await admin.query("GRANT SELECT ON collections.* TO 'collection_writer'@'%'");
    await admin.query("GRANT UPDATE (state, version) ON collections.customers TO 'collection_writer'@'%'");
    await admin.query("GRANT UPDATE (hold_id) ON collections.holds TO 'collection_writer'@'%'");
  }, 90_000);
  afterAll(async () => {
    await admin?.end();
    if (started) execFileSync("docker", ["rm", "-f", name], { stdio: "pipe" });
  });
  beforeEach(async () => {
    await admin.query("DELETE FROM holds"); await admin.query("DELETE FROM customers");
    await admin.query("INSERT INTO customers VALUES ('c1','t1','p1','active',1), ('c2','t1','p2','active',1), ('c3','t2','p1','active',1)");
  });
  async function begin() {
    const connection = await mysql.createConnection({ ...config, user: "collection_writer" });
    // Deliberately differ from the session default to verify the actual worker contract.
    await connection.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.beginTransaction();
    return connection;
  }
  const load = (connection: Connection) => loadActionRuleFacts({ compiled, subjects: f.subjects, trusted: f.facts.trusted,
    mode: "transaction_reverify", adapter: createMysqlActionRuleFactLoader(connection, { executionIsolation: "repeatable_read" }) });
  async function finish(connection: Connection) { try { await connection.rollback(); } finally { await connection.end(); } }
  it("checks an empty collection under exact composite customer scope with narrow writer grants", async () => {
    await admin.query("INSERT INTO holds VALUES ('other','t1','p2','c2','active'), ('other_tenant','t2','p1','c3','active')");
    const connection = await begin();
    try {
      const result = await load(connection);
      expect(result.facts.bindings.holds?.rows).toEqual([]);
      expect(evaluateActionRule({ compiled, facts: result.facts, proposal_id: "p1" }).result).toBe("eligible");
    } finally { await finish(connection); }
  });
  it.each(["insert", "reactivate", "delete", "retarget"] as const)("prevents concurrent %s from invalidating the result before commit", async operation => {
    if (operation === "reactivate" || operation === "delete") await admin.query("INSERT INTO holds VALUES ('h1','t1','p1','c1','released')");
    if (operation === "retarget") await admin.query("INSERT INTO holds VALUES ('h1','t1','p2','c2','active')");
    const connection = await begin();
    const other = await mysql.createConnection(config);
    try {
      const result = await load(connection);
      expect(evaluateActionRule({ compiled, facts: result.facts, proposal_id: "p1" }).result).toBe("eligible");
      await other.query("SET SESSION innodb_lock_wait_timeout=1");
      await other.beginTransaction();
      const mutation = operation === "insert" ? "INSERT INTO holds VALUES ('h1','t1','p1','c1','active')"
        : operation === "delete" ? "DELETE FROM holds WHERE hold_id='h1'"
        : operation === "retarget" ? "UPDATE holds SET principal_id='p1', customer_id='c1' WHERE hold_id='h1'"
        : "UPDATE holds SET state='active' WHERE hold_id='h1'";
      await expect(other.query(mutation)).rejects.toMatchObject({ code: "ER_LOCK_WAIT_TIMEOUT" });
      await other.rollback(); await connection.commit();
      await other.beginTransaction(); await other.query(mutation); await other.rollback();
    } finally { await finish(connection); await finish(other); }
  });
  it("does not accept a session default as proof of the actual transaction isolation", async () => {
    const connection = await begin();
    try {
      await expect(loadActionRuleFacts({ compiled, subjects: f.subjects, trusted: f.facts.trusted, mode: "transaction_reverify",
        adapter: createMysqlActionRuleFactLoader(connection) })).rejects.toThrow("REPEATABLE READ");
    } finally { await finish(connection); }
  });
  it("refuses a newly committed active hold even when the old proposal had none", async () => {
    const initial = await begin();
    try { expect(evaluateActionRule({ compiled, facts: (await load(initial)).facts, proposal_id: "p1" }).result).toBe("eligible"); }
    finally { await finish(initial); }
    await admin.query("INSERT INTO holds VALUES ('h1','t1','p1','c1','active')");
    const changed = await begin();
    try { expect(evaluateActionRule({ compiled, facts: (await load(changed)).facts, proposal_id: "p1" }).result).toBe("ineligible"); }
    finally { await finish(changed); }
  });
});
