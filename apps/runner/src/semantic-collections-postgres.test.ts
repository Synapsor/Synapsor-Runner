import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest, parseExecutionReceipt, parseWritebackJob, parseWritebackResult, type NormalizedWritebackJobV5 } from "@synapsor-runner/protocol";
import type { RunnerConfig } from "@synapsor-runner/worker-core";
import { createActionRuleAuthority } from "../../../packages/action-rules/src/authority.js";
import { createSemanticActionVerifier, evaluateSemanticActionEligibility } from "../../../packages/action-rules/src/runtime.js";
import { completeCollectionFixture } from "../../../packages/action-rules/src/testing/complete-collection-fixture.js";
import { buildDerivedChangeSet } from "../../../packages/mcp-server/src/proposal-builder.js";
import { applyPostgresJobWithClient, bindPostgresActionRuleScope, createPostgresActionRuleFactLoader, postgresReceiptMigrationForConfig } from "../../../packages/postgres/src/index.js";
import { toExecutionReceipt } from "./writeback-domain.js";

// Engine/receipt qualification, not a substitute for the public onboarding journey.
describe.skipIf(process.env.SYNAPSOR_TEST_COMPLETE_COLLECTIONS_LIVE !== "1")("complete collection through real guarded execution and receipts", () => {
  const name = `synapsor-collection-worker-${randomUUID().slice(0, 8)}`;
  const source = completeCollectionFixture("postgres");
  const admissionStatus = { kind: "string", max_length: 16, comparison: "exact", enum: ["admitted", "not_admitted", "withdrawn"] } as const;
  const admissions = structuredClone(source.catalog.resources[1]!);
  admissions.name = "collections.admissions";
  admissions.table = "admissions";
  admissions.primary_key = "admission_id";
  admissions.fields = admissions.fields.filter(field => !["hold_id", "state"].includes(field.name));
  admissions.fields.push({ name: "admission_id", type: { kind: "string", max_length: 64, comparison: "exact" }, nullable: false },
    { name: "status", type: { ...admissionStatus, enum: [...admissionStatus.enum] }, nullable: false },
    { name: "effective_from", type: { kind: "timestamp" }, nullable: false },
    { name: "effective_until", type: { kind: "timestamp" }, nullable: false });
  source.catalog.resources.push(admissions);
  source.catalog.relationships.push({ ...structuredClone(source.catalog.relationships[0]!), name: "admissions_customer_fk", from_resource: admissions.name });
  const admissionBinding = structuredClone(source.verification_boundary.resources[1]!);
  admissionBinding.binding = "admissions";
  admissionBinding.resource = admissions.name;
  admissionBinding.primary_key = "admission_id";
  admissionBinding.fields = admissions.fields;
  admissionBinding.max_rows = 1;
  admissionBinding.deterministic_order = [{ field: "admission_id", direction: "asc" }];
  if (admissionBinding.source.kind !== "relationship") throw new Error("Expected fixture relationship");
  admissionBinding.source.relationship = "admissions_customer_fk";
  source.verification_boundary.resources.push(admissionBinding);
  source.verification_boundary.lock_order = ["customer", "admissions", "holds"];
  source.rule.require = { kind: "all", expressions: [source.rule.require, {
    kind: "exists", binding: "admissions", where: { kind: "all", expressions: [
      { kind: "compare", operator: "eq", left: { kind: "field", binding: "admissions", field: "status" },
        right: { kind: "literal", value: "admitted", value_type: { ...admissionStatus, enum: [...admissionStatus.enum] } } },
      { kind: "compare", operator: "lte", left: { kind: "field", binding: "admissions", field: "effective_from" },
        right: { kind: "trusted", binding: "transaction_time" } },
      { kind: "compare", operator: "gt", left: { kind: "field", binding: "admissions", field: "effective_until" },
        right: { kind: "trusted", binding: "transaction_time" } },
    ] },
  }] };
  source.effect_envelope.writeback = { mode: "direct_sql", supervised_worker: "allowed" };
  for (const field of [{ name: "drop_reason", type: { kind: "string", max_length: 32, comparison: "exact" } as const, nullable: true },
    { name: "dropped_at", type: { kind: "timestamp" } as const, nullable: true }]) {
    source.catalog.resources[0]!.fields.push(field);
    source.effect_envelope.allowed_fields.push({ name: field.name, type: field.type, values: [null] });
    source.rule.effect.set[field.name] = { kind: "literal", value: null, value_type: field.type };
  }
  const now = new Date().toISOString();
  let clock = now;
  const scope = { mode: "postgres_rls", tenantId: "t1", principal: "p1", tenantSetting: "synapsor.tenant_id", principalSetting: "synapsor.principal" } as const;
  const authority = () => createActionRuleAuthority({ name: "collections.authority", action_boundary_name: "collections.actions", catalog: source.catalog,
    rules: [{ read_boundary_name: "collections.read", read_boundary_digest: source.catalog.generation_lock_fingerprint,
      verification_boundary: source.verification_boundary, effect_envelope: source.effect_envelope, rule: source.rule, activated_at: now }] });
  const original = authority();
  let current = original;
  let admin: Pool, reader: Pool, writer: Pool, config: RunnerConfig;
  let started = false;
  beforeAll(async () => {
    execFileSync("docker", ["run", "--rm", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=fixture", "-e", "POSTGRES_DB=collections", "-p", "127.0.0.1::5432", "postgres:17"], { stdio: "pipe" });
    started = true;
    const port = Number(execFileSync("docker", ["port", name, "5432/tcp"], { encoding: "utf8" }).trim().split(":").at(-1));
    const connection = { host: "127.0.0.1", port, database: "collections", user: "postgres", password: "fixture", connectionTimeoutMillis: 1000 };
    admin = new Pool(connection);
    for (let attempt = 0; ; attempt++) {
      try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 60) throw error; await sleep(250); }
    }
    await admin.query(`CREATE SCHEMA collections;
      CREATE ROLE collection_reader LOGIN PASSWORD 'fixture'; CREATE ROLE collection_writer LOGIN PASSWORD 'fixture';
      CREATE TABLE collections.customers (customer_id varchar(64) PRIMARY KEY, tenant_id varchar(64) NOT NULL, principal_id varchar(64) NOT NULL,
        state varchar(16) NOT NULL, version integer NOT NULL,
        drop_reason varchar(32) DEFAULT 'prerequisite_error', dropped_at timestamptz DEFAULT '2026-09-01T00:00:00Z',
        UNIQUE (tenant_id, principal_id, customer_id));
      CREATE TABLE collections.holds (hold_id varchar(64) PRIMARY KEY, tenant_id varchar(64) NOT NULL, principal_id varchar(64) NOT NULL,
        customer_id varchar(64) NOT NULL, state varchar(16) NOT NULL,
        CONSTRAINT holds_customer_fk FOREIGN KEY (tenant_id, principal_id, customer_id) REFERENCES collections.customers (tenant_id, principal_id, customer_id));
      CREATE TABLE collections.admissions (admission_id varchar(64) PRIMARY KEY, tenant_id varchar(64) NOT NULL, principal_id varchar(64) NOT NULL,
        customer_id varchar(64) NOT NULL, status varchar(16) NOT NULL CHECK (status IN ('admitted', 'not_admitted', 'withdrawn')),
        effective_from timestamptz NOT NULL, effective_until timestamptz NOT NULL,
        UNIQUE (tenant_id, principal_id, customer_id), CHECK (effective_from < effective_until),
        CONSTRAINT admissions_customer_fk FOREIGN KEY (tenant_id, principal_id, customer_id) REFERENCES collections.customers (tenant_id, principal_id, customer_id));
      GRANT USAGE ON SCHEMA collections TO collection_reader, collection_writer;
      GRANT SELECT ON ALL TABLES IN SCHEMA collections TO collection_reader, collection_writer;
      GRANT UPDATE (state, version, drop_reason, dropped_at) ON collections.customers TO collection_writer;
      GRANT UPDATE (hold_id) ON collections.holds TO collection_writer;
      GRANT UPDATE (admission_id) ON collections.admissions TO collection_writer;`);
    const rls = "tenant_id::text = nullif(current_setting('synapsor.tenant_id', true), '') AND principal_id::text = nullif(current_setting('synapsor.principal', true), '')";
    for (const table of ["customers", "holds", "admissions"]) await admin.query(`ALTER TABLE collections.${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE collections.${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY read_customer ON collections.${table} FOR SELECT TO collection_reader, collection_writer USING (${rls});
      CREATE POLICY lock_customer ON collections.${table} FOR UPDATE TO collection_writer USING (${rls}) WITH CHECK (${rls});`);
    reader = new Pool({ ...connection, user: "collection_reader" });
    writer = new Pool({ ...connection, user: "collection_writer" });
    config = {
      controlPlaneUrl: "http://127.0.0.1", runnerToken: "fixture", runnerId: "collection_worker", sourceId: "database",
      databaseUrl: `postgresql://collection_writer:fixture@127.0.0.1:${port}/collections`, engine: "postgres", pollIntervalMs: 1000,
      statementTimeoutMs: 3000, logLevel: "error", dryRun: false, stateDir: ".unused",
      databaseScope: scope, receipts: { authority: "source_db", provisioning: "precreated", schema: "collections" },
      semanticActionVerifier: createSemanticActionVerifier({ registry: () => current.registry, clock: () => clock }),
    };
    await admin.query(postgresReceiptMigrationForConfig(config));
    await admin.query("GRANT SELECT, INSERT, UPDATE ON collections.synapsor_writeback_receipts TO collection_writer");
  }, 60_000);
  afterAll(async () => {
    await reader?.end(); await writer?.end(); await admin?.end();
    if (started) execFileSync("docker", ["rm", "-f", name], { stdio: "pipe" });
  });
  beforeEach(async () => {
    current = original;
    clock = now;
    await admin.query(`TRUNCATE collections.holds, collections.admissions, collections.customers, collections.synapsor_writeback_receipts;
      INSERT INTO collections.customers (customer_id, tenant_id, principal_id, state, version) VALUES
        ('c1','t1','p1','active',1), ('c2','t1','p2','active',1), ('c3','t2','p1','active',1);`);
    await admin.query(`INSERT INTO collections.admissions
      SELECT 'a_' || customer_id, tenant_id, principal_id, customer_id, 'admitted', $1::timestamptz, $1::timestamptz + interval '60 seconds'
      FROM collections.customers`, [now]);
  });
  const rows = async () => ({
    customers: (await admin.query("SELECT * FROM collections.customers ORDER BY customer_id")).rows,
    holds: (await admin.query("SELECT * FROM collections.holds ORDER BY hold_id")).rows,
    admissions: (await admin.query("SELECT * FROM collections.admissions ORDER BY admission_id")).rows,
  });
  const receipts = async () => (await admin.query("SELECT * FROM collections.synapsor_writeback_receipts ORDER BY idempotency_key")).rows;
  async function prepare(ledger: ProposalStore, proposalId: string) {
    const client = await reader.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await bindPostgresActionRuleScope(client, scope);
      const decision = await evaluateSemanticActionEligibility({ registry: current.registry, outcome: source.rule.outcome, subjects: source.subjects,
        trusted: { ...source.facts.trusted, transaction_time: clock }, adapter: createPostgresActionRuleFactLoader(client, scope),
        proposal_id: proposalId, trusted_context_digest: canonicalJsonDigest({ tenant: "t1", principal: "p1" }),
        evidence_provenance_digest: canonicalJsonDigest({ proposalId }), verified_at: clock });
      if (decision.result !== "eligible") throw new Error(`Expected an eligible fixture, got ${decision.result}`);
      const proposal = ledger.createProposal(buildDerivedChangeSet({ decision, context: { tenant_id: "t1", principal: "p1", provenance: "static_dev" },
        proposalId, createdAt: now, evidenceBundleId: `ev_${proposalId}`, queryFingerprint: canonicalJsonDigest({ proposalId }) }));
      ledger.approveProposal(proposal.proposal_id, { approver: "fixture_reviewer", proposal_hash: proposal.proposal_hash, proposal_version: proposal.proposal_version });
      const job = parseWritebackJob(ledger.createWritebackJobFromProposal(proposal.proposal_id));
      if (job.protocol_version !== "5.0") throw new Error("Expected a semantic v5 job");
      return job;
    } finally { try { await client.query("ROLLBACK"); } finally { client.release(); } }
  }
  async function apply(job: NormalizedWritebackJobV5, overrides: Partial<RunnerConfig> = {}) {
    const client = await writer.connect();
    try { return parseWritebackResult(await applyPostgresJobWithClient(job, { ...config, ...overrides }, client)); }
    finally { try { await client.query("ROLLBACK"); } finally { client.release(); } }
  }
  async function withProposal(run: (ledger: ProposalStore, job: NormalizedWritebackJobV5) => Promise<void>) {
    const ledger = new ProposalStore(":memory:");
    try { await run(ledger, await prepare(ledger, `wrp_${randomUUID().replaceAll("-", "")}`)); }
    finally { ledger.close(); }
  }
  it("approval changes no rows; completion requires the durable receipt and replay cannot repeat the update", async () => {
    const before = await rows();
    await withProposal(async (ledger, job) => {
      expect(await rows()).toEqual(before); expect(await receipts()).toEqual([]);
      expect(ledger.getProposal(job.proposal_id)?.state).toBe("pending_worker");
      const result = await apply(job);
      expect(result).toMatchObject({ status: "applied", affected_rows: 1, semantic_verification: { status: "reverified" } });
      expect(await rows()).toEqual({ ...before, customers: before.customers.map(row => row.customer_id === "c1" ? { ...row, state: "ready", version: 2, drop_reason: null, dropped_at: null } : row) });
      const durable = await receipts();
      expect(durable).toHaveLength(1); expect(durable[0]).toMatchObject({ status: "applied", result_hash: result.result_hash });
      const receipt = parseExecutionReceipt(toExecutionReceipt(job, result, false));
      expect(receipt).toMatchObject({ rows_affected: 1, source_database_mutated: true });
      ledger.recordExecutionReceipt(receipt);
      expect(ledger.getProposal(job.proposal_id)?.state).toBe("applied");
      const after = await rows();
      expect(await apply(job)).toMatchObject({ status: "already_applied", affected_rows: 0 });
      expect(await rows()).toEqual(after); expect(await receipts()).toEqual(durable);
    });
  });
  it.each(["insert", "reactivate"] as const)("a hold %s after approval refuses before changing the target", async kind => {
    if (kind === "reactivate") await admin.query("INSERT INTO collections.holds VALUES ('h1','t1','p1','c1','released')");
    await withProposal(async (ledger, job) => {
      await admin.query(kind === "insert" ? "INSERT INTO collections.holds VALUES ('h1','t1','p1','c1','active')" : "UPDATE collections.holds SET state='active' WHERE hold_id='h1'");
      const before = await rows();
      await expect(apply(job)).rejects.toMatchObject({ code: "ACTION_RULE_AUTHORITY_STALE" });
      expect(await rows()).toEqual(before); expect(await receipts()).toEqual([]);
      expect(ledger.getProposal(job.proposal_id)?.state).not.toBe("applied");
    });
  });
  async function changeAdmission(kind: string) {
    if (kind === "missing") await admin.query("DELETE FROM collections.admissions WHERE customer_id='c1'");
    else if (kind === "expired") clock = new Date(Date.parse(now) + 60_000).toISOString();
    else if (kind === "future") clock = new Date(Date.parse(now) - 1).toISOString();
    else if (kind === "start_corrected") await admin.query("UPDATE collections.admissions SET effective_from=$1::timestamptz + interval '1 second' WHERE customer_id='c1'", [now]);
    else if (kind === "end_corrected") await admin.query("UPDATE collections.admissions SET effective_from=$1::timestamptz - interval '60 seconds', effective_until=$1::timestamptz WHERE customer_id='c1'", [now]);
    else await admin.query("UPDATE collections.admissions SET status=$1 WHERE customer_id='c1'", [kind]);
  }
  it.each(["missing", "expired", "future", "withdrawn", "not_admitted"])("%s admission cannot authorize a new request", async kind => {
    await changeAdmission(kind);
    const before = await rows(), ledger = new ProposalStore(":memory:");
    try {
      await expect(prepare(ledger, "wrp_admission_refused")).rejects.toThrow("Expected an eligible fixture, got ineligible");
      expect(ledger.getProposal("wrp_admission_refused")).toBeUndefined();
      expect(await rows()).toEqual(before); expect(await receipts()).toEqual([]);
    } finally { ledger.close(); }
  });
  it.each(["missing", "expired", "withdrawn", "not_admitted", "start_corrected", "end_corrected"])("%s admission after approval stops execution without a receipt", async kind => {
    await withProposal(async (ledger, job) => {
      await changeAdmission(kind);
      const before = await rows();
      await expect(apply(job)).rejects.toMatchObject({ code: "ACTION_RULE_AUTHORITY_STALE" });
      expect(await rows()).toEqual(before); expect(await receipts()).toEqual([]);
      expect(ledger.getProposal(job.proposal_id)?.state).not.toBe("applied");
    });
  });
  it.each(["c2", "c3"])("admission for another scoped customer %s cannot supply missing evidence", async customerId => {
    await admin.query("DELETE FROM collections.admissions WHERE customer_id <> $1", [customerId]);
    const before = await rows(), ledger = new ProposalStore(":memory:");
    try {
      expect(before.admissions).toHaveLength(1);
      expect(before.admissions[0]).toMatchObject({ customer_id: customerId, status: "admitted" });
      await expect(prepare(ledger, "wrp_other_admission")).rejects.toThrow("Expected an eligible fixture, got ineligible");
      expect(ledger.getProposal("wrp_other_admission")).toBeUndefined();
      expect(await rows()).toEqual(before); expect(await receipts()).toEqual([]);
    } finally { ledger.close(); }
  });
  it("keeps admission status and effective dates outside both agent effects and writer mutation privileges", async () => {
    expect(source.rule.effect.target_resource).toBe("collections.customers");
    expect(source.effect_envelope.allowed_fields.map(field => field.name)).not.toContain("status");
    const before = await rows();
    for (const role of [reader, writer]) {
      await expect(role.query("UPDATE collections.admissions SET status='admitted', effective_until=now()+interval '1 year'"))
        .rejects.toMatchObject({ code: "42501" });
    }
    expect(await rows()).toEqual(before);
  });
  it("an approved request cannot bypass a new rule, while a newly reviewed request uses that rule", async () => withProposal(async (ledger, job) => {
    const revised = structuredClone(source);
    revised.rule.require = { kind: "all", expressions: [revised.rule.require, { kind: "compare", operator: "lte",
      left: { kind: "field", binding: "customer", field: "version" }, right: { kind: "literal", value: 1, value_type: { kind: "integer" } } }] };
    current = createActionRuleAuthority({ name: "collections.authority", action_boundary_name: "collections.actions", catalog: revised.catalog,
      rules: [{ read_boundary_name: "collections.read", read_boundary_digest: revised.catalog.generation_lock_fingerprint,
        verification_boundary: revised.verification_boundary, effect_envelope: revised.effect_envelope, rule: revised.rule, activated_at: now }] });
    const before = await rows();
    await expect(apply(job)).rejects.toMatchObject({ code: "ACTION_RULE_AUTHORITY_STALE" });
    expect(await rows()).toEqual(before); expect(await receipts()).toEqual([]);
    // Independent ledger represents a newly authorized request; never mutate the old approval.
    const fresh = new ProposalStore(":memory:");
    try {
      const replacement = await prepare(fresh, "wrp_current_policy");
      expect(replacement.semantic_authority.proof.action_rule_digest).not.toBe(job.semantic_authority.proof.action_rule_digest);
      expect(await apply(replacement)).toMatchObject({ status: "applied", affected_rows: 1 });
    } finally { fresh.close(); }
    expect(ledger.getProposal(job.proposal_id)?.state).toBe("pending_worker");
  }));
  it("a receipt failure rolls back the update and permits a verified retry", async () => withProposal(async (ledger, job) => {
    const before = await rows();
    await admin.query(`CREATE FUNCTION collections.reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture receipt failure'; END $$;
      CREATE TRIGGER fail_receipt BEFORE UPDATE ON collections.synapsor_writeback_receipts FOR EACH ROW EXECUTE FUNCTION collections.reject_receipt()`);
    try {
      await expect(apply(job)).rejects.toThrow("fixture receipt failure");
      expect(await rows()).toEqual(before); expect(await receipts()).toEqual([]);
      expect(ledger.getProposal(job.proposal_id)?.state).not.toBe("applied");
    } finally { await admin.query("DROP TRIGGER fail_receipt ON collections.synapsor_writeback_receipts; DROP FUNCTION collections.reject_receipt()"); }
    expect(await apply(job)).toMatchObject({ status: "applied", affected_rows: 1 });
  }));
});
