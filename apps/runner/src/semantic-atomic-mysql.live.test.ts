import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalJsonDigest, parseWritebackJob, parseWritebackResult } from "@synapsor-runner/protocol";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import type { RunnerConfig } from "@synapsor-runner/worker-core";
import { atomicFixture } from "../../../packages/action-rules/src/testing/atomic-fixture.js";
import { buildDerivedChangeSet } from "../../../packages/mcp-server/src/proposal-builder.js";
import { applyMysqlJobWithConnection, createMysqlActionRuleFactLoader, mysqlReceiptMigrationForConfig } from "../../../packages/mysql/src/index.js";

describe.skipIf(process.env.SYNAPSOR_TEST_ATOMIC_MYSQL_LIVE !== "1")("owned MySQL atomic completion and source receipts", () => {
  const name = `synapsor-atomic-mysql-${randomUUID().slice(0, 8)}`;
  const database = "atomic_test";
  const fixture = atomicFixture("mysql", database);
  const config: RunnerConfig = {
    controlPlaneUrl: "http://127.0.0.1", runnerToken: "test", runnerId: "atomic_test", sourceId: "atomic_source",
    databaseUrl: "", engine: "mysql", pollIntervalMs: 1000, logLevel: "error", dryRun: false, stateDir: ".unused",
    receipts: { authority: "source_db", provisioning: "precreated", schema: database }, semanticActionVerifier: fixture.verifier,
  };
  let started = false;
  let admin: Connection;
  let writer: Connection;
  let store: ProposalStore;

  beforeAll(async () => {
    execFileSync("docker", ["run", "--rm", "-d", "--name", name, "-e", "MYSQL_ROOT_PASSWORD=fixture", "-e", `MYSQL_DATABASE=${database}`,
      "-e", "MYSQL_ROOT_HOST=%", "-p", "127.0.0.1::3306", "mysql:8.4"], { stdio: "pipe" });
    started = true;
    const port = Number(execFileSync("docker", ["port", name, "3306/tcp"], { encoding: "utf8" }).trim().split(":").at(-1));
    const connectionConfig = { host: "127.0.0.1", port, database, user: "root", password: "fixture", connectTimeout: 1000 };
    for (let attempt = 0; ; attempt++) {
      try { admin = await mysql.createConnection(connectionConfig); await admin.query("SELECT 1"); break; }
      catch (error) { await admin?.end().catch(() => {}); if (attempt === 120) throw error; await sleep(500); }
    }
    await admin.query(`CREATE TABLE subscriptions (subscription_id varchar(64) PRIMARY KEY, account_id varchar(64) NOT NULL,
      principal_id varchar(64) NOT NULL, plan varchar(64) NOT NULL, version integer NOT NULL) ENGINE=InnoDB COLLATE=utf8mb4_bin`);
    await admin.query(`CREATE TABLE offers (offer_id varchar(64) PRIMARY KEY, account_id varchar(64) NOT NULL, principal_id varchar(64) NOT NULL,
      subscription_id varchar(64) NOT NULL, old_plan varchar(64) NOT NULL, new_plan varchar(64) NOT NULL,
      status varchar(64) NOT NULL CHECK (status IN ('available','consumed')), version integer NOT NULL, expires_at timestamp NOT NULL,
      CONSTRAINT offers_subscription_fk FOREIGN KEY (subscription_id) REFERENCES subscriptions(subscription_id)) ENGINE=InnoDB COLLATE=utf8mb4_bin`);
    await admin.query(mysqlReceiptMigrationForConfig(config));
    await admin.query("CREATE USER 'atomic_writer'@'%' IDENTIFIED BY 'fixture'");
    await admin.query(`GRANT SELECT ON ${database}.* TO 'atomic_writer'@'%'`);
    // Identity-column UPDATE permits locking; the reviewed effects cannot change either identity.
    await admin.query(`GRANT UPDATE (subscription_id,plan,version) ON ${database}.subscriptions TO 'atomic_writer'@'%'`);
    await admin.query(`GRANT UPDATE (offer_id,status,version) ON ${database}.offers TO 'atomic_writer'@'%'`);
    await admin.query(`GRANT INSERT, UPDATE ON ${database}.synapsor_writeback_receipts TO 'atomic_writer'@'%'`);
    writer = await mysql.createConnection({ ...connectionConfig, user: "atomic_writer" });
  }, 90_000);

  afterAll(async () => {
    store?.close();
    await writer?.end().catch(() => {});
    await admin?.end().catch(() => {});
    if (started) execFileSync("docker", ["rm", "-f", name], { stdio: "pipe" });
  });

  beforeEach(async () => {
    store?.close();
    store = new ProposalStore(":memory:");
    await admin.query("DROP TRIGGER IF EXISTS receipt_fail");
    await admin.query("DELETE FROM synapsor_writeback_receipts");
    await admin.query("DELETE FROM offers");
    await admin.query("DELETE FROM subscriptions");
    await admin.query("INSERT INTO subscriptions VALUES ('sub_1','acct_1','customer_1','plan_a',7), ('sibling','acct_1','customer_1','plan_a',7), ('foreign','acct_2','customer_2','plan_a',7)");
    await admin.query("INSERT INTO offers VALUES ('offer_1','acct_1','customer_1','sub_1','plan_a','plan_b','available',4,'2037-01-01'), ('offer_2','acct_1','customer_1','sub_1','plan_a','plan_b','available',4,'2037-01-01'), ('foreign_offer','acct_2','customer_2','foreign','plan_a','plan_b','available',4,'2037-01-01')");
  });

  const rows = async () => ({
    subscriptions: (await admin.query<RowDataPacket[]>("SELECT * FROM subscriptions ORDER BY subscription_id"))[0],
    offers: (await admin.query<RowDataPacket[]>("SELECT * FROM offers ORDER BY offer_id"))[0],
  });
  const receipts = async () => (await admin.query<RowDataPacket[]>("SELECT * FROM synapsor_writeback_receipts ORDER BY idempotency_key"))[0];

  async function decide(id: string, offer = "offer_1") {
    await writer.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await writer.beginTransaction();
    try { return await fixture.decide(createMysqlActionRuleFactLoader(writer), id, offer); }
    finally { await writer.rollback(); }
  }

  async function propose(id: string) {
    const decision = await decide(id);
    if (decision.result !== "eligible") throw new Error(`Expected eligible fixture, got ${decision.result}`);
    const change = buildDerivedChangeSet({ decision, context: { tenant_id: "acct_1", principal: "customer_1", provenance: "static_dev" },
      proposalId: id, createdAt: fixture.now, evidenceBundleId: `ev_${id}`, queryFingerprint: canonicalJsonDigest({ id }) });
    const proposal = store.createProposal(change);
    store.approveProposal(proposal.proposal_id, { approver: "fixture_reviewer", proposal_hash: proposal.proposal_hash, proposal_version: proposal.proposal_version });
    const job = parseWritebackJob(store.createWritebackJobFromProposal(proposal.proposal_id));
    expect(job.protocol_version).toBe("5.0");
    return job;
  }
  const apply = async (job: Awaited<ReturnType<typeof propose>>) => parseWritebackResult(await applyMysqlJobWithConnection(job, config, writer));

  it("completes both scoped records with one receipt, replays once, and refuses permanent offer reuse", async () => {
    const before = await rows();
    const job = await propose("wrp_mysql_success");
    expect(await rows()).toEqual(before);
    expect(await receipts()).toHaveLength(0);
    expect(await apply(job)).toMatchObject({ status: "applied", affected_rows: 2, atomic_effects: [
      { table: "subscriptions", affected_rows: 1 }, { table: "offers", affected_rows: 1 },
    ] });
    const after = await rows();
    expect(after.subscriptions).toEqual(before.subscriptions.map(row => row.subscription_id === "sub_1" ? { ...row, plan: "plan_b", version: 8 } : row));
    expect(after.offers).toEqual(before.offers.map(row => row.offer_id === "offer_1" ? { ...row, status: "consumed", version: 5 } : row));
    expect(await receipts()).toMatchObject([{ status: "applied" }]);
    expect(await apply(job)).toMatchObject({ status: "already_applied", affected_rows: 0 });
    expect(await rows()).toEqual(after);
    expect(await receipts()).toHaveLength(1);
    await admin.query("UPDATE subscriptions SET plan='plan_a',version=version+1 WHERE subscription_id='sub_1'");
    expect(await decide("wrp_mysql_reuse")).toMatchObject({ result: "ineligible" });
    expect(await decide("wrp_mysql_foreign", "foreign_offer")).not.toMatchObject({ result: "eligible" });
  });

  it("rolls back both updates and the receipt claim when receipt persistence fails", async () => {
    const before = await rows();
    const job = await propose("wrp_mysql_rollback");
    await admin.query("CREATE TRIGGER receipt_fail BEFORE UPDATE ON synapsor_writeback_receipts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='owned receipt rollback test'");
    await expect(apply(job)).rejects.toThrow();
    expect(await rows()).toEqual(before);
    expect(await receipts()).toHaveLength(0);
  });

  it("refuses a changed companion version without leaving a partial update or success receipt", async () => {
    const job = await propose("wrp_mysql_stale");
    await admin.query("UPDATE offers SET version=version+1 WHERE offer_id='offer_1'");
    const before = await rows();
    await expect(apply(job)).rejects.toThrow();
    expect(await rows()).toEqual(before);
    expect(await receipts()).toHaveLength(0);
  });
});
