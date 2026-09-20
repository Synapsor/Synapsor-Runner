import { randomBytes } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest, parseExecutionReceipt, parseWritebackJob, parseWritebackResult, type NormalizedWritebackJobV5 } from "@synapsor-runner/protocol";
import type { RunnerConfig } from "@synapsor-runner/worker-core";
import { buildDerivedChangeSet } from "../../../packages/mcp-server/src/proposal-builder.js";
import { atomicFixture } from "../../../packages/action-rules/src/testing/atomic-fixture.js";
import { applyPostgresJobWithClient, createPostgresActionRuleFactLoader, postgresReceiptMigrationForConfig, type PostgresApplyClient } from "../../../packages/postgres/src/index.js";
import { toExecutionReceipt } from "./writeback-domain.js";

const authorizedUrl = process.env.SYNAPSOR_TEST_POSTGRES_URL;

// Never fall back to DATABASE_URL, an acceptance project, or another local database.
async function connected(run: (f: Awaited<ReturnType<typeof createConnectedFixture>>) => Promise<void>) {
  if (!authorizedUrl) throw new Error("Set SYNAPSOR_TEST_POSTGRES_URL to a disposable PostgreSQL database");
  const pool = new Pool({ connectionString: authorizedUrl, max: 6, connectionTimeoutMillis: 3000 });
  const suffix = randomBytes(8).toString("hex");
  const schema = `atomic_${suffix}`;
  const role = `atomic_writer_${suffix}`;
  const store = new ProposalStore(":memory:");
  try {
    await run(await createConnectedFixture(pool, schema, role, store));
  } finally {
    store.close();
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.query(`DROP ROLE IF EXISTS "${role}"`);
      expect((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema])).rows).toEqual([]);
      expect((await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rows).toEqual([]);
    } finally { await pool.end(); }
  }
}

async function createConnectedFixture(pool: Pool, schema: string, role: string, store: ProposalStore) {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  await pool.query(`CREATE TABLE "${schema}".subscriptions (
    subscription_id text PRIMARY KEY, account_id text NOT NULL, principal_id text NOT NULL,
    plan text NOT NULL, version integer NOT NULL)`);
  await pool.query(`CREATE TABLE "${schema}".offers (
    offer_id text PRIMARY KEY, account_id text NOT NULL, principal_id text NOT NULL,
    subscription_id text NOT NULL REFERENCES "${schema}".subscriptions(subscription_id),
    old_plan text NOT NULL, new_plan text NOT NULL, status text NOT NULL CHECK (status IN ('available', 'consumed')),
    version integer NOT NULL, expires_at timestamptz NOT NULL)`);
  await pool.query(`INSERT INTO "${schema}".subscriptions VALUES
    ('sub_1', 'acct_1', 'customer_1', 'plan_a', 7),
    ('sibling', 'acct_1', 'customer_1', 'plan_a', 7),
    ('foreign', 'acct_2', 'customer_2', 'plan_a', 7)`);
  await pool.query(`INSERT INTO "${schema}".offers VALUES
    ('offer_1', 'acct_1', 'customer_1', 'sub_1', 'plan_a', 'plan_b', 'available', 4, '2099-01-01T00:00:00Z'),
    ('offer_2', 'acct_1', 'customer_1', 'sub_1', 'plan_a', 'plan_b', 'available', 4, '2099-01-01T00:00:00Z'),
    ('foreign_offer', 'acct_2', 'customer_2', 'foreign', 'plan_a', 'plan_b', 'available', 4, '2099-01-01T00:00:00Z')`);
  const fixture = atomicFixture("postgres", schema);
  const config: RunnerConfig = {
    controlPlaneUrl: "http://127.0.0.1", runnerToken: "test", runnerId: "atomic_test", sourceId: "atomic_source", databaseUrl: authorizedUrl!,
    engine: "postgres", pollIntervalMs: 1000, statementTimeoutMs: 3000, logLevel: "error", dryRun: false, stateDir: ".unused",
    receipts: { authority: "source_db", provisioning: "precreated", schema }, semanticActionVerifier: fixture.verifier,
  };
  await pool.query(postgresReceiptMigrationForConfig(config));
  await pool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
  await pool.query(`GRANT SELECT ON "${schema}".subscriptions, "${schema}".offers TO "${role}"`);
  await pool.query(`GRANT UPDATE (subscription_id, plan, version) ON "${schema}".subscriptions TO "${role}"`);
  await pool.query(`GRANT UPDATE (offer_id, status, version) ON "${schema}".offers TO "${role}"`);
  await pool.query(`GRANT SELECT, INSERT, UPDATE ON "${schema}".synapsor_writeback_receipts TO "${role}"`);

  const withWriter = async <T>(run: (client: PoolClient) => Promise<T>) => {
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE "${role}"`);
      expect((await client.query("SELECT current_user AS role")).rows[0]).toEqual({ role });
      return await run(client);
    } finally {
      try { await client.query("ROLLBACK"); await client.query("RESET ROLE"); }
      finally { client.release(); }
    }
  };
  const decide = async (proposalId: string, offerId = "offer_1") => withWriter(async client => {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try { return await fixture.decide(createPostgresActionRuleFactLoader(client), proposalId, offerId); }
    finally { await client.query("ROLLBACK"); }
  });
  const propose = async (proposalId: string, offerId = "offer_1", ledger = store) => {
    const decision = await decide(proposalId, offerId);
    if (decision.result !== "eligible") throw new Error(`Expected eligible connected fixture, got ${decision.result}`);
    const change = buildDerivedChangeSet({ decision, context: { tenant_id: "acct_1", principal: "customer_1", provenance: "static_dev" },
      proposalId, createdAt: fixture.now, evidenceBundleId: `ev_${proposalId}`, queryFingerprint: canonicalJsonDigest({ proposalId }) });
    const proposal = ledger.createProposal(change);
    ledger.approveProposal(proposal.proposal_id, { approver: "test_reviewer", proposal_hash: proposal.proposal_hash, proposal_version: proposal.proposal_version });
    const job = parseWritebackJob(ledger.createWritebackJobFromProposal(proposal.proposal_id));
    if (job.protocol_version !== "5.0") throw new Error("Expected normalized semantic v5 job");
    expect(job.semantic_authority.effect.atomic_updates).toEqual(decision.semantic_authority.effect.atomic_updates);
    return job;
  };
  const rows = async () => ({
    subscriptions: (await pool.query(`SELECT * FROM "${schema}".subscriptions ORDER BY subscription_id`)).rows,
    offers: (await pool.query(`SELECT * FROM "${schema}".offers ORDER BY offer_id`)).rows,
  });
  const receipts = async () => (await pool.query(`SELECT * FROM "${schema}".synapsor_writeback_receipts ORDER BY idempotency_key`)).rows;
  const apply = (job: NormalizedWritebackJobV5, options: { verifier?: RunnerConfig["semanticActionVerifier"]; trace?: string[] } = {}) => withWriter(async client => {
    const tracked: PostgresApplyClient = { async query(sql, values) {
      options.trace?.push(sql.trim());
      return client.query(sql, values);
    } };
    return parseWritebackResult(await applyPostgresJobWithClient(job, { ...config, semanticActionVerifier: options.verifier ?? fixture.verifier }, tracked));
  });
  return { pool, schema, role, store, fixture, config, withWriter, decide, propose, rows, receipts, apply };
}

describe.skipIf(!process.env.SYNAPSOR_TEST_POSTGRES_URL)("connected atomic PostgreSQL completion (owned disposable database only)", () => {
  it("emits attempt-bound no-effect proof only after a live source_db stale-fact rollback", async () => connected(async f => {
    const job = await f.propose("wrp_connected_rollback_evidence");
    await f.pool.query(`UPDATE "${f.schema}".subscriptions SET version=version+1 WHERE subscription_id='sub_1'`);
    const afterOwner = await f.rows();
    const evidence: unknown[] = [];
    f.config.onSourceRollback = e => { evidence.push(e); };
    await expect(f.apply(job)).rejects.toThrow();
    expect(evidence).toEqual([expect.objectContaining({ producer: "synapsor.postgres.source_db.rollback.v1", outcome: "rollback_acknowledged", job_digest: canonicalJsonDigest(job) })]);
    expect(await f.rows()).toEqual(afterOwner); expect(await f.receipts()).toEqual([]);
  }));

  it("proposal and approval are read-only; one durable receipt binds two targets; replay does not repeat either write", async () => connected(async f => {
    const before = await f.rows();
    const job = await f.propose("wrp_connected_atomic_success");
    expect(await f.rows()).toEqual(before);
    expect(await f.receipts()).toEqual([]);
    const trace: string[] = [];
    const result = await f.apply(job, { trace });
    expect(result).toMatchObject({ status: "applied", affected_rows: 2, atomic_effects: [
      { table: "subscriptions", affected_rows: 1 }, { table: "offers", affected_rows: 1 },
    ], semantic_verification: { status: "reverified", effect_digest: job.semantic_authority.effect.effect_digest } });
    const after = await f.rows();
    expect(after.subscriptions).toEqual(before.subscriptions.map(row => row.subscription_id === "sub_1" ? { ...row, plan: "plan_b", version: 8 } : row));
    expect(after.offers).toEqual(before.offers.map(row => row.offer_id === "offer_1" ? { ...row, status: "consumed", version: 5 } : row));
    expect(trace.filter(sql => sql === "BEGIN")).toHaveLength(1);
    expect(trace.filter(sql => sql === "COMMIT")).toHaveLength(1);
    const sourceReceipts = await f.receipts();
    expect(sourceReceipts).toHaveLength(1);
    expect(sourceReceipts[0]).toMatchObject({ status: "applied", result_hash: result.result_hash,
      semantic_verification_json: { effect_digest: job.semantic_authority.effect.effect_digest, status: "reverified" } });
    expect(await f.apply(job)).toMatchObject({ status: "already_applied", affected_rows: 0,
      atomic_effects: [{ table: "subscriptions", affected_rows: 0 }, { table: "offers", affected_rows: 0 }],
      semantic_verification: { status: "previously_reverified", effect_digest: job.semantic_authority.effect.effect_digest } });
    expect(await f.rows()).toEqual(after);
    expect(await f.receipts()).toEqual(sourceReceipts);
    const receipt = parseExecutionReceipt(toExecutionReceipt(job, result, false));
    expect(receipt).toMatchObject({ schema_version: "synapsor.execution-receipt.v5", rows_affected: 2, source_database_mutated: true,
      atomic_effects: [{ table: "subscriptions", affected_rows: 1 }, { table: "offers", affected_rows: 1 }] });
    f.store.recordExecutionReceipt(receipt);
    expect(f.store.receipts(job.proposal_id)).toHaveLength(1);
    expect(f.store.getProposal(job.proposal_id)).toMatchObject({ state: "applied" });
  }), 20_000);

  it.each(["constraint", "zero", "version", "receipt"] as const)("real %s failure after the first write leaves both rows unchanged and fresh eligibility intact", async failure => connected(async f => {
    const job = await f.propose(`wrp_connected_${failure}`);
    if (failure === "constraint") await f.pool.query(`ALTER TABLE "${f.schema}".offers ADD CONSTRAINT injected_second_member_failure CHECK (status <> 'consumed')`);
    else {
      const table = failure === "receipt" ? "synapsor_writeback_receipts" : "offers";
      const body = failure === "receipt" ? "RAISE EXCEPTION 'injected receipt failure';"
        : failure === "zero" ? "RETURN NULL;" : "NEW.version := OLD.version; RETURN NEW;";
      await f.pool.query(`CREATE FUNCTION "${f.schema}".inject_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$`);
      await f.pool.query(`CREATE TRIGGER atomic_injected_failure BEFORE UPDATE ON "${f.schema}".${table} FOR EACH ROW EXECUTE FUNCTION "${f.schema}".inject_failure()`);
    }
    const before = await f.rows();
    const trace: string[] = [];
    await expect(f.apply(job, { trace })).rejects.toThrow();
    expect(trace.filter(sql => sql.startsWith(`UPDATE "${f.schema}"."subscriptions"`))).toHaveLength(1);
    expect(trace.filter(sql => sql.startsWith(`UPDATE "${f.schema}"."offers"`))).toHaveLength(1);
    expect(trace).toContain("ROLLBACK");
    expect(trace).not.toContain("COMMIT");
    expect(await f.rows()).toEqual(before);
    expect(await f.receipts()).toEqual([]);
    expect(f.store.getProposal(job.proposal_id)?.state).not.toBe("applied");
    expect(await f.decide(`wrp_fresh_after_${failure}`)).toMatchObject({ result: "eligible" });
  }), 20_000);

  it("a companion version change after approval refuses the whole request before either UPDATE", async () => connected(async f => {
    const job = await f.propose("wrp_connected_version_conflict");
    await f.pool.query(`UPDATE "${f.schema}".offers SET version = version + 1 WHERE offer_id = 'offer_1'`);
    const before = await f.rows();
    const trace: string[] = [];
    await expect(f.apply(job, { trace })).rejects.toMatchObject({ code: "ACTION_RULE_AUTHORITY_STALE" });
    expect(trace.filter(sql => sql.startsWith(`UPDATE "${f.schema}"`))).toEqual([]);
    expect(await f.rows()).toEqual(before);
    expect(await f.receipts()).toEqual([]);
  }), 20_000);

  it("consumption permanently refuses a NEW request even after testadmin restores the old plan and advances its version", async () => connected(async f => {
    const job = await f.propose("wrp_original_acceptance");
    expect(await f.apply(job)).toMatchObject({ status: "applied", affected_rows: 2 });
    await f.pool.query(`UPDATE "${f.schema}".subscriptions SET plan = 'plan_a', version = version + 1 WHERE subscription_id = 'sub_1'`);
    const before = await f.rows();
    expect(before.subscriptions.find(row => row.subscription_id === "sub_1")).toMatchObject({ plan: "plan_a", version: 9 });
    const offer = before.offers.find(row => row.offer_id === "offer_1")!;
    expect(offer).toMatchObject({ old_plan: "plan_a", status: "consumed", version: 5 });
    expect(new Date(offer.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(await f.decide("wrp_distinct_request_after_restore")).toMatchObject({ result: "ineligible" });
    expect(await f.decide("wrp_other_still_available", "offer_2")).toMatchObject({ result: "eligible" });
    expect(await f.rows()).toEqual(before);
    expect(await f.receipts()).toHaveLength(1);
  }), 20_000);

  it.each(["same_offer", "different_offers"] as const)("distinct approved requests race on %s with at most one whole completion", async kind => connected(async f => {
    const first = await f.propose("wrp_race_first");
    // Independent runner ledgers each retain the one-active-proposal invariant.
    const otherLedger = new ProposalStore(":memory:");
    let second: NormalizedWritebackJobV5;
    try { second = await f.propose("wrp_race_second", kind === "same_offer" ? "offer_1" : "offer_2", otherLedger); }
    finally { otherLedger.close(); }
    expect(first.proposal_id).not.toBe(second.proposal_id);
    expect(first.idempotency_key).not.toBe(second.idempotency_key);
    expect(first.approval_id).not.toBe(second.approval_id);
    const before = await f.rows();
    let arrived = 0;
    let release!: () => void;
    let gateTimeout!: ReturnType<typeof setTimeout>;
    const gate = new Promise<void>((resolve, reject) => {
      release = resolve;
      gateTimeout = setTimeout(() => reject(new Error("Both contenders did not reach transaction verification")), 5000);
    });
    const verifier: NonNullable<RunnerConfig["semanticActionVerifier"]> = async input => {
      arrived++;
      if (arrived === 2) release();
      // Barrier before locked fact loading; never wait while holding the other contender's row lock.
      await gate;
      return f.fixture.verifier(input);
    };
    const outcomes = await Promise.allSettled([f.apply(first, { verifier }), f.apply(second, { verifier })])
      .finally(() => clearTimeout(gateTimeout));
    expect(arrived).toBe(2);
    const winners = outcomes.filter(outcome => outcome.status === "fulfilled" && outcome.value.status === "applied");
    expect(winners).toHaveLength(1);
    const loser = outcomes.find(outcome => outcome.status === "rejected");
    expect(loser).toBeDefined();
    if (loser?.status === "rejected") expect(["40001", "ACTION_RULE_AUTHORITY_STALE"]).toContain(loser.reason.code);
    const after = await f.rows();
    expect(after.subscriptions).toEqual(before.subscriptions.map(row => row.subscription_id === "sub_1" ? { ...row, plan: "plan_b", version: 8 } : row));
    expect(after.offers.filter(row => row.status === "consumed")).toHaveLength(1);
    const winningJob = outcomes[0]!.status === "fulfilled" ? first : second;
    const winningOffer = winningJob.semantic_authority.effect.atomic_updates![0]!.primary_key.value;
    expect(after.offers).toEqual(before.offers.map(row => row.offer_id === winningOffer ? { ...row, status: "consumed", version: 5 } : row));
    expect(await f.receipts()).toHaveLength(1);
    expect(await f.apply(winningJob)).toMatchObject({ status: "already_applied", affected_rows: 0 });
    expect(await f.rows()).toEqual(after);
  }), 20_000);

  it("an offer lock-only writer is insufficient and cannot commit the subscription alone", async () => connected(async f => {
    const job = await f.propose("wrp_lock_only_writer");
    await f.pool.query(`REVOKE UPDATE (status, version) ON "${f.schema}".offers FROM "${f.role}"`);
    const before = await f.rows();
    const trace: string[] = [];
    await expect(f.apply(job, { trace })).rejects.toMatchObject({ code: "42501" });
    expect(trace.filter(sql => sql.startsWith(`UPDATE "${f.schema}"."subscriptions"`))).toHaveLength(1);
    expect(await f.rows()).toEqual(before);
    expect(await f.receipts()).toEqual([]);
  }), 20_000);
});
