import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest, parseExecutionReceipt, parseWritebackJob, parseWritebackResult, type NormalizedWritebackJobV5 } from "@synapsor-runner/protocol";
import { inspectDatabase, schemaFingerprintForInspection } from "@synapsor-runner/schema-inspector";
import type { RunnerConfig } from "@synapsor-runner/worker-core";
import { createActionRuleAuthority } from "../../../packages/action-rules/src/authority.js";
import { createSemanticActionVerifier, evaluateSemanticActionEligibility, reverifySemanticProposal } from "../../../packages/action-rules/src/runtime.js";
import { requiredSingletonAllocationFixture } from "../../../packages/action-rules/src/testing/required-singleton-allocation-fixture.js";
import { buildDerivedChangeSet } from "../../../packages/mcp-server/src/proposal-builder.js";
import { applyPostgresJobWithClient, bindPostgresActionRuleScope, createPostgresActionRuleFactLoader,
  postgresReceiptMigrationForConfig } from "../../../packages/postgres/src/index.js";
import { toExecutionReceipt } from "./writeback-domain.js";

// Engine/receipt/concurrency qualification on a FRESH explicitly owned database.
// Never attaches to the original/paid authoring Source. The launcher preserves
// this database at exit, including failures; it does not auto-remove evidence.
describe.skipIf(process.env.SYNAPSOR_TEST_REQUIRED_SINGLETON_LIVE !== "1")("required singleton through real PostgreSQL guarded execution", () => {
  let admin: Pool, reader: Pool, writer: Pool, config: RunnerConfig;
  let source: ReturnType<typeof requiredSingletonAllocationFixture>;
  let current: ReturnType<typeof createActionRuleAuthority>;
  const now = new Date().toISOString();
  const scope = { mode: "postgres_rls", tenantId: "t1", principal: "p1", tenantSetting: "synapsor.tenant_id", principalSetting: "synapsor.principal" } as const;
  let rls = true;
  let caseRoot: string, caseNumber = 0;
  const readerQueries: string[] = [];
  beforeAll(async () => {
    const fixturePath = process.env.SYNAPSOR_REQUIRED_SINGLETON_FIXTURE_CONFIG;
    if (!fixturePath) throw new Error("An owned fresh B36 fixture configuration is required.");
    const f = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as { admin: string; reader: string; writer: string; owned: string };
    if (f.owned !== "B36_FRESH_RUNTIME_ONLY") throw new Error("Wrong synthetic runtime fixture boundary.");
    admin = new Pool({ connectionString: f.admin, max: 6 });
    reader = new Pool({ connectionString: f.reader, max: 2 });
    writer = new Pool({ connectionString: f.writer, max: 3 });
    caseRoot = path.join(path.dirname(fixturePath), "test-cases");
    fs.mkdirSync(caseRoot, { mode: 0o700 });
    expect((await admin.query("SHOW server_version")).rows[0].server_version).toMatch(/^17\.10(?:\s|$)/u);
    // These roles must have been created by the labelled fresh fixture launcher.
    expect((await admin.query("SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname='b36'")).rowCount).toBe(0);
    await admin.query(`CREATE SCHEMA b36;
      CREATE TYPE b36.unit_status AS ENUM ('open','ready','held');
      CREATE TABLE b36.units (id varchar(64) PRIMARY KEY, tenant_id varchar(64) NOT NULL, principal_id varchar(64) NOT NULL,
        allocated_count integer NOT NULL, blocked boolean NOT NULL, version integer NOT NULL, status b36.unit_status NOT NULL);
      CREATE TABLE b36.eligibility (id varchar(64) PRIMARY KEY, tenant_id varchar(64) NOT NULL, principal_id varchar(64) NOT NULL,
        allowed boolean NOT NULL, capacity integer NOT NULL,
        CONSTRAINT eligibility_unit_fk FOREIGN KEY(id) REFERENCES b36.units(id));
      GRANT USAGE ON SCHEMA b36 TO b36_reader,b36_writer;
      GRANT SELECT ON b36.units,b36.eligibility TO b36_reader,b36_writer;
      GRANT UPDATE(allocated_count,version) ON b36.units TO b36_writer;
      GRANT UPDATE(id) ON b36.eligibility TO b36_writer;`);
    const predicate = "tenant_id::text = nullif(current_setting('synapsor.tenant_id',true),'') AND principal_id::text = nullif(current_setting('synapsor.principal',true),'')";
    for (const table of ["units", "eligibility"]) {
      await admin.query(`ALTER TABLE b36.${table} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE b36.${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY scoped_read ON b36.${table} FOR SELECT TO b36_reader,b36_writer USING (${predicate});
        CREATE POLICY scoped_lock ON b36.${table} FOR UPDATE TO b36_writer USING (${predicate})
          WITH CHECK (${table === "eligibility" ? "false" : predicate});`);
    }
    config = { controlPlaneUrl: "http://127.0.0.1", runnerToken: "fixture", runnerId: "b36_worker", sourceId: "database",
      databaseUrl: f.writer, engine: "postgres", pollIntervalMs: 1000, statementTimeoutMs: 5000, logLevel: "error", dryRun: false, stateDir: ".unused",
      databaseScope: scope, receipts: { authority: "source_db", provisioning: "precreated", schema: "b36" } };
    await admin.query(postgresReceiptMigrationForConfig(config));
    await admin.query("GRANT SELECT,INSERT,UPDATE ON b36.synapsor_writeback_receipts TO b36_writer");
    const inspection = await inspectDatabase({ engine: "postgres", databaseUrlEnv: "B36_SOURCE", env: { B36_SOURCE: f.reader }, schema: "b36" });
    const parent = inspection.tables.find(t => t.name === "units")!, witness = inspection.tables.find(t => t.name === "eligibility")!;
    const proof = witness.foreign_keys.find(k => k.name === "eligibility_unit_fk")?.required_singleton_proof;
    expect(proof).toBeDefined();
    expect(parent.columns.find(c => c.name === "status")!.enum_values).toEqual(["open", "ready", "held"]);
    expect(parent.columns.find(c => c.name === "status")!.postgres_declaration_digest).toBeUndefined();
    const declarations = (columns: typeof parent.columns) => Object.fromEntries(columns.flatMap(c =>
      c.postgres_declaration_digest ? [[c.name, c.postgres_declaration_digest] as const] : []));
    source = requiredSingletonAllocationFixture({ generation_lock_fingerprint: schemaFingerprintForInspection(inspection), relationship_proof: proof!,
      column_declarations: { parent: declarations(parent.columns), witness: declarations(witness.columns) } });
    current = createActionRuleAuthority({ name: "b36.authority", action_boundary_name: "b36.actions", catalog: source.catalog,
      rules: [{ read_boundary_name: "b36.read", read_boundary_digest: source.catalog.generation_lock_fingerprint,
        verification_boundary: source.verification_boundary, effect_envelope: source.effect_envelope, rule: source.rule, activated_at: now }] });
    config.semanticActionVerifier = createSemanticActionVerifier({ registry: () => current.registry, clock: () => now });
  }, 30_000);
  afterAll(async () => { await reader?.end(); await writer?.end(); await admin?.end(); });
  beforeEach(async () => {
    caseNumber++;
    fs.mkdirSync(path.join(caseRoot, String(caseNumber)), { mode: 0o700 });
    readerQueries.length = 0;
    rls = true;
    await admin.query(`ALTER TABLE b36.units ENABLE ROW LEVEL SECURITY; ALTER TABLE b36.eligibility ENABLE ROW LEVEL SECURITY;
      TRUNCATE b36.eligibility,b36.units,b36.synapsor_writeback_receipts;
      INSERT INTO b36.units VALUES ('u1','t1','p1',0,false,1,'open'),('u2','t1','p2',0,false,1,'open'),('u3','t2','p1',0,false,1,'open');
      INSERT INTO b36.eligibility VALUES ('u1','t1','p1',true,20),('u2','t1','p2',true,20),('u3','t2','p1',true,20);`);
  });
  afterEach(async () => {
    // Restricted synthetic evidence only. Runtime/model projections are tested
    // separately; these operator records never become a tool result.
    const state = { rows: await rows(), receipts: await receipts(), reader_queries: readerQueries,
      role_privileges: (await admin.query("SELECT r.rolname,r.rolsuper,r.rolbypassrls,has_column_privilege(r.rolname,'b36.eligibility','id','UPDATE') AS lock_permission,has_column_privilege(r.rolname,'b36.eligibility','capacity','UPDATE') AS private_write_permission FROM pg_catalog.pg_roles r WHERE r.rolname IN ('b36_reader','b36_writer') ORDER BY r.rolname")).rows };
    fs.writeFileSync(path.join(caseRoot, String(caseNumber), "final-state.json"), JSON.stringify(state, null, 2)+"\n", { mode: 0o600, flag: "wx" });
  });
  const ledgerForCase = (label = "") => new ProposalStore(path.join(caseRoot, String(caseNumber), `control${label ? `-${label}` : ""}.sqlite`));
  const rows = async () => ({ units: (await admin.query("SELECT * FROM b36.units ORDER BY id")).rows,
    eligibility: (await admin.query("SELECT * FROM b36.eligibility ORDER BY id")).rows });
  const receipts = async () => (await admin.query("SELECT * FROM b36.synapsor_writeback_receipts ORDER BY idempotency_key")).rows;
  async function decision(client: PoolClient, proposalId: string, amount = 2,
    actor = { tenant: "t1", principal: "p1" }, subjects = source.subjects) {
    await bindPostgresActionRuleScope(client, { ...scope, tenantId: actor.tenant, principal: actor.principal });
    const observed = { query: async (sql: string, values?: unknown[]) => { readerQueries.push(sql); return client.query(sql, values); } };
    return evaluateSemanticActionEligibility({ registry: current.registry, outcome: source.rule.outcome, subjects,
      inputs: { units: amount }, trusted: { ...actor, transaction_time: now }, adapter: createPostgresActionRuleFactLoader(observed, rls ? { ...scope, tenantId: actor.tenant, principal: actor.principal } : undefined),
      proposal_id: proposalId, trusted_context_digest: canonicalJsonDigest(actor),
      evidence_provenance_digest: canonicalJsonDigest({ proposalId }), verified_at: now });
  }
  async function prepare(ledger: ProposalStore, actor = { tenant: "t1", principal: "p1" }, subjects = source.subjects) {
    const client = await reader.connect(), proposalId = `wrp_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
      const d = await decision(client, proposalId, 2, actor, subjects);
      if (d.result !== "eligible") throw new Error(`Expected eligible fixture, got ${d.result}`);
      const proposal = ledger.createProposal(buildDerivedChangeSet({ decision: d, context: { tenant_id: actor.tenant, principal: actor.principal, provenance: "static_dev" },
        proposalId, createdAt: now, evidenceBundleId: `ev_${proposalId}`, queryFingerprint: canonicalJsonDigest({ proposalId }) }));
      ledger.approveProposal(proposal.proposal_id, { approver: "b36_fixture_reviewer", proposal_hash: proposal.proposal_hash, proposal_version: proposal.proposal_version });
      const job = parseWritebackJob(ledger.createWritebackJobFromProposal(proposal.proposal_id));
      if (job.protocol_version !== "5.0") throw new Error("Expected canonical semantic v5 job");
      return job;
    } finally { await client.query("ROLLBACK"); client.release(); }
  }
  async function apply(job: NormalizedWritebackJobV5, hook?: () => Promise<void>, connected?: (pid: number) => void) {
    const client = await writer.connect();
    try {
      connected?.((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const verifier = config.semanticActionVerifier!;
      return parseWritebackResult(await applyPostgresJobWithClient(job, { ...config, ...(rls ? {} : { databaseScope: undefined }),
        semanticActionVerifier: async input => { const result = await verifier(input); await hook?.(); return result; } }, client));
    } finally { try { await client.query("ROLLBACK"); } finally { client.release(); } }
  }
  it("requires no UPDATE privilege for reader snapshots and preserves private material during the exact approved effect", async () => {
    const before = await rows(), ledger = ledgerForCase();
    try {
      const job = await prepare(ledger);
      expect(readerQueries.some(sql => sql.includes("FOR UPDATE"))).toBe(false);
      expect(await rows()).toEqual(before); expect(await receipts()).toEqual([]);
      const result = await apply(job);
      expect(result).toMatchObject({ status: "applied", affected_rows: 1, semantic_verification: { status: "reverified" } });
      expect(await rows()).toEqual({ ...before, units: before.units.map(row => row.id === "u1" ? { ...row, allocated_count: 2, version: 2 } : row) });
      const durable = await receipts(); expect(durable).toHaveLength(1);
      expect(durable[0]).toMatchObject({ status: "applied", result_hash: result.result_hash, idempotency_key: job.idempotency_key });
      const receipt = parseExecutionReceipt(toExecutionReceipt(job, result, false));
      ledger.recordExecutionReceipt(receipt);
      expect(ledger.getProposal(job.proposal_id)?.state).toBe("applied");
      for (const actor of [reader, writer]) await expect(actor.query("UPDATE b36.eligibility SET capacity=99 WHERE id='u1'"))
        .rejects.toMatchObject({ code: "42501" });
      expect(await rows()).toEqual({ ...before, units: before.units.map(row => row.id === "u1" ? { ...row, allocated_count: 2, version: 2 } : row) });
    } finally { ledger.close(); }
  });
  it.each(["missing", "tenant", "principal", "blocked", "not_allowed", "capacity"])("%s cannot create an eligible proposal", async kind => {
    if (kind === "missing") await admin.query("DELETE FROM b36.eligibility WHERE id='u1'");
    if (kind === "tenant") await admin.query("UPDATE b36.eligibility SET tenant_id='t2' WHERE id='u1'");
    if (kind === "principal") await admin.query("UPDATE b36.eligibility SET principal_id='p2' WHERE id='u1'");
    if (kind === "blocked") await admin.query("UPDATE b36.units SET blocked=true WHERE id='u1'");
    if (kind === "not_allowed") await admin.query("UPDATE b36.eligibility SET allowed=false WHERE id='u1'");
    if (kind === "capacity") await admin.query("UPDATE b36.eligibility SET capacity=1 WHERE id='u1'");
    const before = await rows(), c = await reader.connect();
    try {
      await c.query("BEGIN READ ONLY"); const d = await decision(c, "wrp_refused");
      expect(d.result).not.toBe("eligible");
      // Internal decisions carry canonical metadata and are not the model-facing
      // projection. The separate four-tool privacy gate checks that boundary.
      expect(await rows()).toEqual(before); expect(await receipts()).toEqual([]);
    } finally { await c.query("ROLLBACK"); c.release(); }
  });
  it("requires generated scope predicates even with RLS disabled in this labelled synthetic control", async () => {
    rls = false;
    await admin.query("ALTER TABLE b36.units DISABLE ROW LEVEL SECURITY; ALTER TABLE b36.eligibility DISABLE ROW LEVEL SECURITY; UPDATE b36.eligibility SET principal_id='p2' WHERE id='u1'");
    const c = await reader.connect();
    try { await c.query("BEGIN READ ONLY"); expect((await decision(c, "wrp_no_rls_foreign")).result).not.toBe("eligible"); }
    finally { await c.query("ROLLBACK"); c.release(); }
    expect(readerQueries.filter(sql => sql.includes('FROM ONLY "b36".')).every(sql => sql.includes('"tenant_id" =') && sql.includes('"principal_id" ='))).toBe(true);
    expect(await receipts()).toEqual([]);
  });
  it.each(["capacity", "allowed", "tenant", "principal", "link", "deleted", "parent_scope", "parent_version"])("%s drift invalidates the exact approved dependencies", async kind => {
    const ledger = ledgerForCase();
    try {
      if (kind === "link") await admin.query("INSERT INTO b36.units VALUES ('u4','t1','p1',0,false,1,'open')");
      const job = await prepare(ledger);
      if (kind === "capacity") await admin.query("UPDATE b36.eligibility SET capacity=10 WHERE id='u1'");
      if (kind === "allowed") await admin.query("UPDATE b36.eligibility SET allowed=false WHERE id='u1'");
      if (kind === "tenant") await admin.query("UPDATE b36.eligibility SET tenant_id='t2' WHERE id='u1'");
      if (kind === "principal") await admin.query("UPDATE b36.eligibility SET principal_id='p2' WHERE id='u1'");
      if (kind === "link") await admin.query("UPDATE b36.eligibility SET id='u4' WHERE id='u1'");
      if (kind === "deleted") await admin.query("DELETE FROM b36.eligibility WHERE id='u1'");
      if (kind === "parent_scope") await admin.query("UPDATE b36.units SET tenant_id='t2' WHERE id='u1'");
      if (kind === "parent_version") await admin.query("UPDATE b36.units SET version=2 WHERE id='u1'");
      const before = await rows();
      await expect(apply(job)).rejects.toMatchObject({ code: "ACTION_RULE_AUTHORITY_STALE" });
      expect(await rows()).toEqual(before); expect(await receipts()).toEqual([]);
    } finally { ledger.close(); }
  });
  it.each(["child_key", "fk_missing", "fk_deferred", "fk_unvalidated", "nullable_material", "material_type", "ri_disabled"])("%s catalogue drift refuses before source effects", async kind => {
    const ledger = ledgerForCase();
    try {
      const job = await prepare(ledger), before = await rows();
      try {
        if (kind === "child_key") await admin.query("ALTER TABLE b36.eligibility DROP CONSTRAINT eligibility_pkey");
        if (kind === "fk_missing" || kind === "fk_unvalidated") await admin.query("ALTER TABLE b36.eligibility DROP CONSTRAINT eligibility_unit_fk");
        if (kind === "fk_unvalidated") await admin.query("ALTER TABLE b36.eligibility ADD CONSTRAINT eligibility_unit_fk FOREIGN KEY(id) REFERENCES b36.units(id) NOT VALID");
        if (kind === "fk_deferred") await admin.query("ALTER TABLE b36.eligibility ALTER CONSTRAINT eligibility_unit_fk DEFERRABLE INITIALLY DEFERRED");
        if (kind === "nullable_material") await admin.query("ALTER TABLE b36.eligibility ALTER COLUMN capacity DROP NOT NULL");
        if (kind === "material_type") await admin.query("ALTER TABLE b36.eligibility ALTER COLUMN capacity TYPE bigint");
        if (kind === "ri_disabled") await admin.query("ALTER TABLE b36.eligibility DISABLE TRIGGER ALL");
        await expect(apply(job)).rejects.toMatchObject({ code: "ACTION_RULE_SCOPE_UNPROVEN" });
        // bigint is canonically returned as text; compare the numerical value
        // here only, while the independent declaration hash must still refuse.
        const actual = await rows();
        if (kind === "material_type") actual.eligibility = actual.eligibility.map(row => ({ ...row, capacity: Number(row.capacity) }));
        expect(actual).toEqual(before); expect(await receipts()).toEqual([]);
      } finally {
        if (kind === "child_key") await admin.query("ALTER TABLE b36.eligibility ADD CONSTRAINT eligibility_pkey PRIMARY KEY(id)");
        if (kind === "fk_missing") await admin.query("ALTER TABLE b36.eligibility ADD CONSTRAINT eligibility_unit_fk FOREIGN KEY(id) REFERENCES b36.units(id)");
        if (kind === "fk_unvalidated") await admin.query("ALTER TABLE b36.eligibility VALIDATE CONSTRAINT eligibility_unit_fk");
        if (kind === "fk_deferred") await admin.query("ALTER TABLE b36.eligibility ALTER CONSTRAINT eligibility_unit_fk NOT DEFERRABLE");
        if (kind === "nullable_material") await admin.query("ALTER TABLE b36.eligibility ALTER COLUMN capacity SET NOT NULL");
        if (kind === "material_type") await admin.query("ALTER TABLE b36.eligibility ALTER COLUMN capacity TYPE integer");
        if (kind === "ri_disabled") await admin.query("ALTER TABLE b36.eligibility ENABLE TRIGGER ALL");
      }
    } finally { ledger.close(); }
  });
  it("refuses revoked lock privilege before an effect or receipt", async () => {
    const ledger = ledgerForCase();
    try {
      const job = await prepare(ledger), before = await rows();
      await admin.query("REVOKE UPDATE(id) ON b36.eligibility FROM b36_writer");
      try { await expect(apply(job)).rejects.toMatchObject({ code: "ACTION_RULE_SCOPE_UNPROVEN" }); }
      finally { await admin.query("GRANT UPDATE(id) ON b36.eligibility TO b36_writer"); }
      expect(await rows()).toEqual(before); expect(await receipts()).toEqual([]);
    } finally { ledger.close(); }
  });
  it.each(["capacity", "allowed", "tenant", "principal", "link", "deleted", "parent_scope", "parent_version"])("%s changes wait behind the exact worker transaction until commit", async kind => {
    const ledger = ledgerForCase();
    const competitor = await admin.connect();
    let release!: () => void, reached!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const protection = new Promise<void>(resolve => { reached = resolve; });
    let workerPid = 0;
    try {
      if (kind === "link") await admin.query("INSERT INTO b36.units VALUES ('u4','t1','p1',0,false,1,'open')");
      const job = await prepare(ledger), before = await rows();
      const running = apply(job, async () => { reached(); await blocked; }, pid => { workerPid = pid; });
      // Observe an actual reached barrier, or the actual worker failure; a
      // failed setup must not leave the fixture waiting on an impossible hook.
      const early = running.then(() => { throw new Error("Worker completed before the protected barrier."); });
      await Promise.race([protection, early]);
      const competitorPid = (await competitor.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const sql: Record<string, string> = {
        capacity: "UPDATE b36.eligibility SET capacity=10 WHERE id='u1'",
        allowed: "UPDATE b36.eligibility SET allowed=false WHERE id='u1'",
        tenant: "UPDATE b36.eligibility SET tenant_id='t2' WHERE id='u1'",
        principal: "UPDATE b36.eligibility SET principal_id='p2' WHERE id='u1'",
        link: "UPDATE b36.eligibility SET id='u4' WHERE id='u1'",
        deleted: "DELETE FROM b36.eligibility WHERE id='u1'",
        parent_scope: "UPDATE b36.units SET tenant_id='t2' WHERE id='u1'",
        parent_version: "UPDATE b36.units SET version=version+1 WHERE id='u1'",
      };
      const update = competitor.query(sql[kind]!);
      let observed = false;
      try {
        for (let check = 0; check < 100; check++) {
          const state = (await admin.query("SELECT wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_catalog.pg_stat_activity WHERE pid=$1", [competitorPid])).rows[0];
          if (state?.wait_event_type === "Lock" && state.blockers.includes(workerPid)) { observed = true; break; }
          await sleep(10);
        }
        expect(observed).toBe(true);
        expect(await rows()).toEqual(before);
      } finally { release(); }
      expect(await running).toMatchObject({ status: "applied", affected_rows: 1 });
      await update;
      expect(await receipts()).toHaveLength(1);
      const changed = { capacity: { capacity: 10 }, allowed: { allowed: false }, tenant: { tenant_id: "t2" },
        principal: { principal_id: "p2" }, link: { id: "u4" } }[kind as "capacity" | "allowed" | "tenant" | "principal" | "link"];
      expect(await rows()).toEqual({ units: before.units.map(row => row.id === "u1" ? { ...row, allocated_count: 2,
        version: kind === "parent_version" ? 3 : 2, ...(kind === "parent_scope" ? { tenant_id: "t2" } : {}) } : row),
        eligibility: before.eligibility.filter(row => kind !== "deleted" || row.id !== "u1")
          .map(row => row.id === "u1" ? { ...row, ...changed } : row).sort((a, b) => a.id.localeCompare(b.id)) });
    } finally { release?.(); competitor.release(); ledger.close(); }
  }, 15_000);

  it("two approved allocations serialize at the exact remaining capacity", async () => {
    // One host deliberately refuses a second active proposal for an object.
    // Two independent canonical host stores exercise the shared-source engine
    // race without bypassing that outer guard or claiming a one-host UI route.
    const ledger = ledgerForCase(), other = ledgerForCase("independent-host");
    let release!: () => void, reached!: () => void, firstPid = 0, secondPid = 0;
    const pause = new Promise<void>(resolve => { release = resolve; });
    const protectedFirst = new Promise<void>(resolve => { reached = resolve; });
    try {
      await admin.query("UPDATE b36.eligibility SET capacity=2 WHERE id='u1'");
      const before = await rows(), firstJob = await prepare(ledger);
      await expect(prepare(ledger)).rejects.toMatchObject({ code: "PROPOSAL_ALREADY_EXISTS" });
      expect(ledger.getProposal(firstJob.proposal_id)?.state).toBe("pending_worker");
      expect(await rows()).toEqual(before); expect(await receipts()).toEqual([]);
      const secondJob = await prepare(other);
      const first = apply(firstJob, async () => { reached(); await pause; }, pid => { firstPid = pid; });
      await Promise.race([protectedFirst, first.then(() => { throw new Error("No allocation barrier reached"); })]);
      const second = apply(secondJob, undefined, pid => { secondPid = pid; })
        .then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
      let waits = false;
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          const state = (await admin.query("SELECT wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_catalog.pg_stat_activity WHERE pid=$1", [secondPid])).rows[0];
          if (state?.wait_event_type === "Lock" && state.blockers.includes(firstPid)) { waits = true; break; }
          await sleep(10);
        }
        expect(waits).toBe(true); expect(await rows()).toEqual(before);
      } finally { release(); }
      const firstResult = await first;
      ledger.recordExecutionReceipt(parseExecutionReceipt(toExecutionReceipt(firstJob, firstResult, false)));
      expect((await second).error).toMatchObject({ code: "ACTION_RULE_AUTHORITY_STALE" });
      expect(await rows()).toEqual({ ...before, units: before.units.map(row => row.id === "u1" ? { ...row, allocated_count: 2, version: 2 } : row) });
      expect(await receipts()).toHaveLength(1);
      expect((await receipts())[0]).toMatchObject({ idempotency_key: firstJob.idempotency_key });
      expect(ledger.getProposal(firstJob.proposal_id)?.state).toBe("applied");
      expect(other.getProposal(secondJob.proposal_id)?.state).toBe("pending_worker");
      const c = await reader.connect();
      try { await c.query("BEGIN READ ONLY"); expect((await decision(c, "wrp_after_capacity")).result).not.toBe("eligible"); }
      finally { await c.query("ROLLBACK"); c.release(); }
    } finally { release?.(); ledger.close(); other.close(); }
  }, 15_000);

  it("rebinds two trusted actors on the same physical worker session without scope leakage", async () => {
    const ledger = ledgerForCase(), client = await writer.connect();
    try {
      const before = await rows(), pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const firstJob = await prepare(ledger);
      const secondJob = await prepare(ledger, { tenant: "t2", principal: "p1" },
        [{ ...source.subjects[0]!, primary_key: { column: "id", value: "u3" } }]);
      const first = parseWritebackResult(await applyPostgresJobWithClient(firstJob, config, client));
      ledger.recordExecutionReceipt(parseExecutionReceipt(toExecutionReceipt(firstJob, first, false)));
      await expect(applyPostgresJobWithClient(secondJob, config, client)).rejects.toThrow("POSTGRES_RLS_TENANT_CONTEXT_MISMATCH");
      await client.query("ROLLBACK");
      const second = parseWritebackResult(await applyPostgresJobWithClient(secondJob,
        { ...config, databaseScope: { ...scope, tenantId: "t2", principal: "p1" } }, client));
      ledger.recordExecutionReceipt(parseExecutionReceipt(toExecutionReceipt(secondJob, second, false)));
      expect((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid).toBe(pid);
      expect((await client.query("SELECT nullif(current_setting('synapsor.tenant_id',true),'') AS tenant,nullif(current_setting('synapsor.principal',true),'') AS principal")).rows[0])
        .toEqual({ tenant: null, principal: null });
      expect(await rows()).toEqual({ ...before, units: before.units.map(row => ["u1", "u3"].includes(row.id) ? { ...row, allocated_count: 2, version: 2 } : row) });
      expect(await receipts()).toHaveLength(2);
      expect(ledger.getProposal(firstJob.proposal_id)?.state).toBe("applied");
      expect(ledger.getProposal(secondJob.proposal_id)?.state).toBe("applied");
    } finally { await client.query("ROLLBACK"); client.release(); ledger.close(); }
  });

  it("rechecks approval snapshots and requires a fresh mandate after absent evidence is inserted", async () => {
    const ledger = ledgerForCase(), freshHost = ledgerForCase("fresh-host"), client = await reader.connect();
    const snapshot = async (job: NormalizedWritebackJobV5) => {
      await client.query("BEGIN READ ONLY");
      await bindPostgresActionRuleScope(client, scope);
      const observed = { query: async (sql: string, values?: unknown[]) => { readerQueries.push(sql); return client.query(sql, values); } };
      try { return await reverifySemanticProposal({ registry: current.registry, job,
        factLoader: createPostgresActionRuleFactLoader(observed, scope), checkedAt: now }); }
      finally { await client.query("ROLLBACK"); }
    };
    try {
      const job = await prepare(ledger), original = await rows();
      expect(await snapshot(job)).toMatchObject({ status: "reverified" });
      expect(readerQueries.some(sql => sql.includes("FOR UPDATE"))).toBe(false);
      await admin.query("UPDATE b36.eligibility SET capacity=10 WHERE id='u1'");
      await expect(snapshot(job)).rejects.toMatchObject({ code: "ACTION_RULE_AUTHORITY_STALE" });
      await admin.query("DELETE FROM b36.eligibility WHERE id='u1'");
      await client.query("BEGIN READ ONLY");
      try { expect((await decision(client, "wrp_absent_before_insert")).result).not.toBe("eligible"); }
      finally { await client.query("ROLLBACK"); }
      await admin.query("INSERT INTO b36.eligibility VALUES ('u1','t1','p1',true,10)");
      await expect(snapshot(job)).rejects.toMatchObject({ code: "ACTION_RULE_AUTHORITY_STALE" });
      // The old pending item remains fenced in its original host. This is a
      // freshly evaluated separate host fixture, not same-host queue recovery.
      const fresh = await prepare(freshHost);
      expect(fresh.proposal_id).not.toBe(job.proposal_id);
      const result = await apply(fresh);
      freshHost.recordExecutionReceipt(parseExecutionReceipt(toExecutionReceipt(fresh, result, false)));
      expect(await rows()).toEqual({ units: original.units.map(row => row.id === "u1" ? { ...row, allocated_count: 2, version: 2 } : row),
        eligibility: original.eligibility.map(row => row.id === "u1" ? { ...row, capacity: 10 } : row) });
      expect(await receipts()).toHaveLength(1);
      expect((await receipts())[0]).toMatchObject({ idempotency_key: fresh.idempotency_key });
      expect(ledger.getProposal(job.proposal_id)?.state).toBe("pending_worker");
    } finally { client.release(); ledger.close(); freshHost.close(); }
  });

  it.each(["declaration", "policy"])("late %s DDL waits behind the actual protected transaction", async kind => {
    const ledger = ledgerForCase(), competitor = await admin.connect();
    let release!: () => void, reached!: () => void, workerPid = 0;
    const pause = new Promise<void>(resolve => { release = resolve; });
    const protectedRows = new Promise<void>(resolve => { reached = resolve; });
    try {
      const before = await rows(), job = await prepare(ledger);
      const running = apply(job, async () => { reached(); await pause; }, pid => { workerPid = pid; });
      await Promise.race([protectedRows, running.then(() => { throw new Error("No DDL barrier reached"); })]);
      // A new SELECT would itself queue behind the forthcoming ACCESS EXCLUSIVE
      // request. Observe unchanged rows at the reached barrier BEFORE queuing
      // DDL, then use catalogue lock observations until the worker is released.
      expect(await rows()).toEqual(before);
      const competitorPid = (await competitor.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const ddl = competitor.query(kind === "declaration"
        ? "ALTER TABLE b36.eligibility ALTER COLUMN capacity DROP NOT NULL"
        : "ALTER POLICY scoped_lock ON b36.eligibility WITH CHECK (false)");
      let waits = false;
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          const state = (await admin.query("SELECT wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_catalog.pg_stat_activity WHERE pid=$1", [competitorPid])).rows[0];
          if (state?.wait_event_type === "Lock" && state.blockers.includes(workerPid)) { waits = true; break; }
          await sleep(10);
        }
        expect(waits).toBe(true);
      } finally { release(); }
      const result = await running;
      ledger.recordExecutionReceipt(parseExecutionReceipt(toExecutionReceipt(job, result, false)));
      await ddl;
      expect(await rows()).toEqual({ ...before, units: before.units.map(row => row.id === "u1" ? { ...row, allocated_count: 2, version: 2 } : row) });
      expect(await receipts()).toHaveLength(1);
    } finally {
      release?.();
      if (kind === "declaration") await admin.query("ALTER TABLE b36.eligibility ALTER COLUMN capacity SET NOT NULL");
      competitor.release(); ledger.close();
    }
  }, 15_000);

  it("records actual late RI-maintenance ordering without claiming all catalogue metadata is locked", async () => {
    const ledger = ledgerForCase(), laterHost = ledgerForCase("later-host"), competitor = await admin.connect();
    let release!: () => void, reached!: () => void;
    const pause = new Promise<void>(resolve => { release = resolve; });
    const protectedRows = new Promise<void>(resolve => { reached = resolve; });
    const events: { event: string; at: string }[] = [];
    let trigger = "";
    const mark = (event: string) => { events.push({ event, at: new Date().toISOString() }); };
    try {
      const before = await rows(), firstJob = await prepare(ledger), laterJob = await prepare(laterHost);
      trigger = (await admin.query("SELECT t.tgname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_constraint c ON c.oid=t.tgconstraint WHERE c.conname='eligibility_unit_fk' AND c.conrelid='b36.eligibility'::regclass AND t.tgrelid=c.conrelid AND t.tgisinternal ORDER BY t.tgname LIMIT 1")).rows[0].tgname;
      const first = apply(firstJob, async () => { mark("verifier_reached"); reached(); await pause; });
      await Promise.race([protectedRows, first.then(() => { throw new Error("No RI ordering barrier reached"); })]);
      const ddl = competitor.query(`ALTER TABLE b36.eligibility DISABLE TRIGGER "${trigger.replaceAll('"', '""')}"`)
        .then(() => { mark("ri_maintenance_committed"); });
      // Record whether maintenance commits while protected rows are held, or
      // waits. Either ordering is measured; no unsupported lock-mode oracle.
      await Promise.race([ddl, sleep(100)]);
      expect(await rows()).toEqual(before);
      release();
      const result = await first; mark("first_effect_committed");
      ledger.recordExecutionReceipt(parseExecutionReceipt(toExecutionReceipt(firstJob, result, false)));
      await ddl;
      expect(await receipts()).toHaveLength(1);
      expect(await rows()).toEqual({ ...before, units: before.units.map(row => row.id === "u1" ? { ...row, allocated_count: 2, version: 2 } : row) });
      await expect(apply(laterJob)).rejects.toMatchObject({ code: "ACTION_RULE_SCOPE_UNPROVEN" });
      mark("later_worker_refused_current_unsupported_proof");
      expect(await receipts()).toHaveLength(1);
    } finally {
      release?.();
      if (trigger) await admin.query(`ALTER TABLE b36.eligibility ENABLE TRIGGER "${trigger.replaceAll('"', '""')}"`);
      fs.writeFileSync(path.join(caseRoot, String(caseNumber), "ri-ordering.json"), JSON.stringify({ events,
        scope: "Exact observed serialization; no immutable-RI-through-commit or automatic unsafe-effect conclusion" }, null, 2)+"\n", { flag: "wx", mode: 0o600 });
      competitor.release(); ledger.close(); laterHost.close();
    }
  }, 15_000);

  it.each(["key_identity", "external_dependency", "ambiguous_key", "inheritance"])("publishes and rechecks the real legal %s catalogue variant", async kind => {
    const ledger = ledgerForCase();
    const fixture = JSON.parse(fs.readFileSync(process.env.SYNAPSOR_REQUIRED_SINGLETON_FIXTURE_CONFIG!, "utf8")) as { reader: string };
    const inspect = () => inspectDatabase({ engine: "postgres", databaseUrlEnv: "B36_SOURCE", env: { B36_SOURCE: fixture.reader }, schema: "b36" });
    const selected = (inspection: Awaited<ReturnType<typeof inspect>>) => inspection.tables.find(t => t.name === "eligibility")!;
    try {
      const job = await prepare(ledger), before = await rows();
      if (kind === "key_identity") {
        await admin.query("ALTER TABLE b36.units RENAME CONSTRAINT units_pkey TO units_key_renewed");
        const proof = selected(await inspect()).foreign_keys.find(k => k.name === "eligibility_unit_fk")!.required_singleton_proof;
        expect(proof).toBeDefined();
        expect(canonicalJsonDigest(proof)).not.toBe(canonicalJsonDigest(source.catalog.relationships[0]!.required_singleton_proof));
      } else if (kind === "external_dependency") {
        await admin.query("ALTER TABLE b36.eligibility ALTER COLUMN capacity SET DEFAULT 20; ALTER TABLE b36.eligibility ADD CONSTRAINT capacity_native_nonnegative CHECK (capacity>=0)");
        expect(selected(await inspect()).columns.find(c => c.name === "capacity")!.postgres_declaration_digest).toBeDefined();
        await admin.query("CREATE FUNCTION b36.private_capacity_default() RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 20'; ALTER TABLE b36.eligibility ALTER COLUMN capacity SET DEFAULT b36.private_capacity_default()");
        expect(selected(await inspect()).columns.find(c => c.name === "capacity")!.postgres_declaration_digest).toBeUndefined();
      } else if (kind === "ambiguous_key") {
        await admin.query("ALTER TABLE b36.eligibility ADD CONSTRAINT eligibility_duplicate_identity UNIQUE(id)");
        expect(selected(await inspect()).foreign_keys.find(k => k.name === "eligibility_unit_fk")!.required_singleton_proof).toBeUndefined();
      } else {
        await admin.query("CREATE TABLE b36.eligibility_shadow () INHERITS (b36.eligibility)");
        expect(selected(await inspect()).foreign_keys.find(k => k.name === "eligibility_unit_fk")!.required_singleton_proof).toBeUndefined();
      }
      await expect(apply(job)).rejects.toMatchObject({ code: "ACTION_RULE_SCOPE_UNPROVEN" });
      expect(await rows()).toEqual(before); expect(await receipts()).toEqual([]);
    } finally {
      if (kind === "key_identity") await admin.query("ALTER TABLE b36.units RENAME CONSTRAINT units_key_renewed TO units_pkey");
      if (kind === "external_dependency") await admin.query("ALTER TABLE b36.eligibility ALTER COLUMN capacity DROP DEFAULT; ALTER TABLE b36.eligibility DROP CONSTRAINT capacity_native_nonnegative; DROP FUNCTION b36.private_capacity_default()");
      if (kind === "ambiguous_key") await admin.query("ALTER TABLE b36.eligibility DROP CONSTRAINT eligibility_duplicate_identity");
      if (kind === "inheritance") await admin.query("DROP TABLE b36.eligibility_shadow");
      ledger.close();
    }
  });
});
