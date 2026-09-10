import { describe, expect, it } from "vitest";
import { parseWritebackResult } from "@synapsor-runner/protocol";
import type { RunnerConfig, WritebackIntentStore } from "@synapsor-runner/worker-core";
import { atomicFixture, atomicJob, atomicMemoryLoader, AtomicState, type AtomicFailure } from "../../action-rules/src/testing/atomic-fixture.js";
import { applyMysqlJobWithConnection, buildMysqlReconciliationRead, type MysqlApplyConnection } from "./index.js";

class IntentStore implements WritebackIntentStore {
  result?: ReturnType<typeof parseWritebackResult>;
  unknown = false;
  claimWritebackIntent() {
    if (this.unknown) return { decision: "reconciliation_required" as const, intent_id: "wbi:atomic", reason: "Source outcome unknown" };
    return this.result ? { decision: "existing_result" as const, intent_id: "wbi:atomic", result: this.result }
      : { decision: "proceed" as const, intent_id: "wbi:atomic" };
  }
  markWritebackIntentApplying() {}
  completeWritebackIntent(_id: string, result: Parameters<WritebackIntentStore["completeWritebackIntent"]>[1]) { this.result = parseWritebackResult(result); }
  requireWritebackReconciliation() { this.unknown = true; }
}

class StatefulMysql implements MysqlApplyConnection {
  state: AtomicState;
  log: string[] = [];
  timezone = "+05:30";
  constructor(failure?: AtomicFailure, failAt = 2) { this.state = new AtomicState(failure, failAt); }
  async beginTransaction() { this.log.push("BEGIN"); this.state.begin(); }
  async commit() { this.log.push("COMMIT"); this.state.commit(); }
  async rollback() { this.log.push("ROLLBACK"); this.state.rollback(); }
  async query<T = unknown>(sql: string, values: unknown[] = []): Promise<[T, unknown]> {
    sql = sql.trim();
    this.log.push(sql);
    return [await this.execute(sql, values) as T, undefined];
  }
  private async execute(sql: string, values: unknown[]) {
    if (sql === "SELECT @@session.time_zone AS time_zone") return [{ time_zone: this.timezone }];
    if (sql.startsWith("SET SESSION time_zone = ?")) { this.timezone = String(values[0]); return {}; }
    if (sql.startsWith("SET ")) return {};
    if (sql.startsWith("SELECT ENGINE AS storage_engine")) {
      expect(values[0]).toBe("atomic_test");
      expect(["subscriptions", "offers"]).toContain(values[1]);
      return [{ storage_engine: "InnoDB", table_type: "BASE TABLE", table_collation: "utf8mb4_bin" }];
    }
    if (sql.startsWith("INSERT IGNORE INTO synapsor_writeback_receipts")) {
      const receipts = this.state.transaction!.receipts;
      if (receipts[String(values[0])]) return { affectedRows: 0 };
      receipts[String(values[0])] = { job_id: values[1], proposal_id: values[2], status: "in_progress", result_hash: null };
      return { affectedRows: 1 };
    }
    if (sql.startsWith("UPDATE synapsor_writeback_receipts")) {
      if (this.state.failure === "receipt") throw new Error("receipt persistence failed");
      Object.assign(this.state.transaction!.receipts[String(values[3])]!, { status: values[0], result_hash: values[1], semantic_verification_json: values[2] });
      return { affectedRows: 1 };
    }
    if (sql.startsWith("SELECT job_id, proposal_id, status")) {
      const receipt = this.state.transaction!.receipts[String(values[0])];
      return receipt ? [receipt] : [];
    }
    const table = (["subscriptions", "offers"] as const).find(table => sql.includes(`\`atomic_test\`.\`${table}\``));
    if (!table) throw new Error(`Unexpected MySQL SQL: ${sql}`);
    if (sql.startsWith("SELECT")) {
      expect(sql).toContain("FOR UPDATE");
      const versionRead = sql.startsWith("SELECT `version` AS __synapsor_result_version");
      expect(values).toEqual([table === "subscriptions" ? "sub_1" : "offer_1", "acct_1", "customer_1", ...(versionRead ? [] : [2])]);
      const rows = this.state.transaction!.rows[table].filter(row => row[table === "subscriptions" ? "subscription_id" : "offer_id"] === values[0]
        && row.account_id === values[1] && row.principal_id === values[2]);
      return versionRead ? rows.map(row => ({ __synapsor_result_version: row.version })) : structuredClone(rows);
    }
    if (!sql.startsWith("UPDATE")) throw new Error(`Unexpected mutation: ${sql}`);
    expect(sql).toContain("`version` = `version` + 1");
    expect(sql).toContain("AND `version` = ?");
    expect(sql).toContain("AND `account_id` = ?");
    expect(sql).toContain("AND `principal_id` = ?");
    const updated = this.state.update(table, values);
    return { affectedRows: updated.count };
  }
}

async function setup(authority: "source_db" | "runner_ledger", failure?: AtomicFailure, failAt = 2) {
  const fixture = atomicFixture("mysql");
  const connection = new StatefulMysql(failure, failAt);
  const store = new IntentStore();
  const job = await atomicJob(fixture, connection.state.rows);
  const config: RunnerConfig = {
    controlPlaneUrl: "http://127.0.0.1", runnerToken: "test", runnerId: "atomic_test", sourceId: "atomic_source", databaseUrl: "",
    engine: "mysql", pollIntervalMs: 1000, logLevel: "error", dryRun: false, stateDir: ".unused",
    receipts: { authority, provisioning: "precreated" }, writebackIntentStore: store, semanticActionVerifier: fixture.verifier,
  };
  return { fixture, connection, store, job, config, apply: () => applyMysqlJobWithConnection(job, config, connection) };
}

describe.each(["source_db", "runner_ledger"] as const)("MySQL atomic updates: %s", authority => {
  it("commits both exact targets once, produces aggregate proof and replays idempotently", async () => {
    const f = await setup(authority);
    const before = structuredClone(f.connection.state.rows);
    const result = parseWritebackResult(await f.apply());
    expect(result).toMatchObject({ status: "applied", affected_rows: 2, atomic_effects: [
      { table: "subscriptions", affected_rows: 1, target_identity: expect.arrayContaining([{ column: "subscription_id", value: "sub_1" }]) },
      { table: "offers", affected_rows: 1, target_identity: expect.arrayContaining([{ column: "offer_id", value: "offer_1" }]) },
    ], semantic_verification: { status: "reverified", effect_digest: f.job.semantic_authority.effect.effect_digest } });
    expect(f.connection.state.rows.subscriptions).toEqual([{ ...before.subscriptions[0], plan: "plan_b", version: 8 }, ...before.subscriptions.slice(1)]);
    expect(f.connection.state.rows.offers).toEqual([{ ...before.offers[0], status: "consumed", version: 5 }, before.offers[1]]);
    expect(f.connection.state.commits).toBe(1);
    expect(f.connection.state.rollbacks).toBe(0);
    expect(f.connection.log.indexOf("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")).toBeLessThan(f.connection.log.indexOf("BEGIN"));
    expect(f.connection.timezone).toBe("+05:30");
    if (authority === "source_db") expect(Object.values(f.connection.state.receipts)).toHaveLength(1);
    else expect(f.store.result).toEqual(result);
    const after = structuredClone(f.connection.state.rows);
    expect(parseWritebackResult(await f.apply())).toMatchObject({ status: "already_applied", affected_rows: 0,
      atomic_effects: [{ table: "subscriptions", affected_rows: 0 }, { table: "offers", affected_rows: 0 }],
      semantic_verification: { status: "previously_reverified", effect_digest: f.job.semantic_authority.effect.effect_digest } });
    expect(f.connection.state.rows).toEqual(after);
    expect(f.connection.state.updates).toBe(2);
  });

  it.each(["zero", "excess", "throw", "version"] as const)("second member %s restores actual modeled row and receipt state", async failure => {
    const f = await setup(authority, failure);
    const before = structuredClone(f.connection.state.rows);
    if (authority === "source_db") await expect(f.apply()).rejects.toThrow();
    else expect(await f.apply()).toMatchObject({ status: "failed", affected_rows: 0 });
    expect(f.connection.state.updates).toBe(2);
    expect(f.connection.state.rows).toEqual(before);
    expect(f.connection.state.receipts).toEqual({});
    expect(f.connection.state.rollbacks).toBe(1);
    expect(f.connection.state.commits).toBe(0);
    expect(f.connection.timezone).toBe("+05:30");
    expect(await f.fixture.decide(atomicMemoryLoader("mysql", f.connection.state.rows), "wrp_after_rollback")).toMatchObject({ result: "eligible" });
  });

  it("does not run the companion when the first member fails", async () => {
    const f = await setup(authority, "zero", 1);
    const before = structuredClone(f.connection.state.rows);
    if (authority === "source_db") await expect(f.apply()).rejects.toThrow();
    else expect(await f.apply()).toMatchObject({ status: "failed", affected_rows: 0 });
    expect(f.connection.state.updates).toBe(1);
    expect(f.connection.state.rows).toEqual(before);
    expect(f.connection.state.commits).toBe(0);
  });
});

describe("MySQL atomic receipt and unknown outcome safety", () => {
  it("receipt failure after both writes restores rows and removes the uncommitted receipt claim", async () => {
    const f = await setup("source_db", "receipt");
    const before = structuredClone(f.connection.state.rows);
    await expect(f.apply()).rejects.toThrow("receipt persistence failed");
    expect(f.connection.state.updates).toBe(2);
    expect(f.connection.state.rows).toEqual(before);
    expect(f.connection.state.receipts).toEqual({});
    expect(f.connection.state.rollbacks).toBe(1);
  });

  it.each(["commit_unknown", "rollback_unknown"] as const)("%s cannot silently retry or reconcile one target", async failure => {
    const f = await setup("runner_ledger", failure);
    expect(await f.apply()).toMatchObject({ status: "reconciliation_required" });
    const attempts = f.connection.state.updates;
    expect(attempts).toBe(2);
    expect(f.store.result).toBeUndefined();
    expect(await f.apply()).toMatchObject({ status: "reconciliation_required" });
    expect(f.connection.state.updates).toBe(attempts);
    expect(() => buildMysqlReconciliationRead(f.job)).toThrow();
  });

  it("does not replay a successful source receipt with missing semantic proof", async () => {
    const f = await setup("source_db");
    await f.apply();
    f.connection.state.receipts[f.job.idempotency_key]!.semantic_verification_json = null;
    expect(await f.apply()).toMatchObject({ status: "failed", affected_rows: 0, error_code: "SOURCE_RECEIPT_SEMANTIC_PROOF_UNAVAILABLE" });
    expect(f.connection.state.updates).toBe(2);
  });
});
