import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveOperatorIdentity } from "./operator-identity.js";
import { semanticAtomicEffectResult, sourceRollbackBinding } from "@synapsor-runner/worker-core";
import { blockedClosureLines, inspectBlockedClosureSource } from "./worker-blocked-closure.js";
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }); });
async function operator(proposal: StoredProposal, action: OperatorDecision["action"], reason?: string, roles = ["recovery_operator"]) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "closure-operator-")); dirs.push(d);
  // Existing signed-key implementation uses SHA256/RSA.
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await fs.writeFile(path.join(d, "public.pem"), rsa.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
  await fs.writeFile(path.join(d, "private.pem"), rsa.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return resolveOperatorIdentity({ config: { provider: "signed_key", operators: { reviewer: { public_key_path: "public.pem", roles } } },
    configPath: path.join(d, "config.json"), proposal, action, reason, identity: "reviewer", privateKeyPath: path.join(d, "private.pem") });
}
import { semanticRequestLifecycle } from "../../../packages/mcp-server/src/semantic-request-lifecycle.js";
import { afterEach, describe, expect, it } from "vitest";
import { ProposalStore, blockedClosureDecisionReason, type OperatorDecision, type StoredProposal } from "@synapsor-runner/proposal-store";
import { atomicFixture, atomicMemoryLoader, atomicRows } from "../../../packages/action-rules/src/testing/atomic-fixture.js";
import { buildDerivedChangeSet } from "../../../packages/mcp-server/src/proposal-builder.js";
import { canonicalJsonDigest, parseWritebackJob } from "@synapsor-runner/protocol";
import { toExecutionReceipt } from "./writeback-domain.js";

async function blocked(store: ProposalStore, proof = false) {
  await store.controlPolicies.initialize();
  await store.controlPolicies.importDeployment({ deployment_id: "closure", project_id: "closure_project", migration_digest: canonicalJsonDigest("closure"), revisions: [], active: [], event: { event_id: "closure_import", actor: "fixture_owner", occurred_at: new Date().toISOString(), receipt: {} } });
  const f = atomicFixture("postgres"), id = "wrp_closure_baseline";
  const decision = await f.decide(atomicMemoryLoader("postgres", atomicRows()), id);
  if (decision.result !== "eligible") throw new Error("Fixture must be eligible");
  const change = buildDerivedChangeSet({ decision, context: { tenant_id: "acct_1", principal: "customer_1", provenance: "static_dev" },
    proposalId: id, createdAt: f.now, evidenceBundleId: "ev_closure_baseline", queryFingerprint: canonicalJsonDigest(id) });
  const proposal = store.createProposal(change);
  store.approveProposalByPolicy(id, { policy: "fixture_automatic", proposal_hash: proposal.proposal_hash, proposal_version: 1, reason: "Derived store test automatic approval", action_boundary: { name: "atomic.actions", digest: decision.activated.action_boundary_digest, limits: [] } });
  store.enqueueWorkerProposal({ proposal_id: id, execution_mode: "supervised_worker", contract_digest: decision.activated.action_boundary_digest,
    cancellation_control_role: "recovery_operator" });
  const item = store.claimWorkerItem({ workerId: "fixture_worker", executionMode: "supervised_worker" })!;
  store.recordOperatorAuthorization(id, await operator(proposal, "apply"), true);
  const job = parseWritebackJob(store.createWritebackJobFromProposal(id, { attempt: item.attempts }));
  if (job.protocol_version !== "5.0") throw new Error("Expected semantic job");
  // Derived lifecycle fixture, not evidence that a source transaction occurred.
  const p = job.semantic_authority.proof;
  const observed = new Date().toISOString();
  const receipt = toExecutionReceipt(job, { protocol_version: "5.0", job_id: job.job_id, runner_id: "fixture_worker",
    operation: job.operation, receipt_authority: "source_db", status: "failed", affected_rows: 0,
    target_identity: [{ column: job.target.primary_key.column, value: job.target.primary_key.value! }], semantic_verification: { status: "refused", proof_digest: p.proof_digest,
      action_rule_digest: p.action_rule_digest, compiled_plan_digest: p.compiled_plan_digest,
      proposal_dependency_set_digest: p.dependency_set_digest, effect_digest: p.derived_effect_digest },
    atomic_effects: [job.semantic_authority.effect, ...(job.semantic_authority.effect.atomic_updates ?? [])].map(effect => semanticAtomicEffectResult(effect)),
    error_code: "SEMANTIC_AUTHORITY_STALE", completed_at: new Date().toISOString() }, false);
  store.recordExecutionReceipt(receipt, proof ? { producer: "synapsor.postgres.source_db.rollback.v1", outcome: "rollback_acknowledged",
    job_digest: canonicalJsonDigest(job), source_binding_digest: canonicalJsonDigest("fixture-source"), observed_at: observed,
    required_roles: ["recovery_operator"], execution_config_digest: canonicalJsonDigest("fixture-config"), writer_reference: "FIXTURE_WRITER",
    receipt_namespace: { schema: "atomic_test", table: "synapsor_writeback_receipts" } } : undefined);
  store.blockWorkerItem({ proposalId: id, workerId: "fixture_worker", leaseId: item.lease_id!, errorCode: "SEMANTIC_AUTHORITY_STALE" });
  return { proposal, job, receipt, change, item, fixture: f };
}

describe("blocked lifecycle baseline (derived fixture, no source-outcome proof)", () => {
  it("cannot use queued cancellation; failed state already releases active-subject lookup and old ID stays old", async () => {
    const store = new ProposalStore();
    try {
      const f = await blocked(store), old = store.getProposal(f.proposal.proposal_id)!;
      expect(old.state).toBe("failed");
      expect(store.getWorkerQueueItem(old.proposal_id)).toMatchObject({ status: "blocked", attempts: 1 });
      expect(() => store.cancelWorkerItem({ proposalId: old.proposal_id, actor: "baseline" })).toThrow();
      expect(store.findActiveProposal({ tenant_id: old.tenant_id, action: old.action, business_object: old.business_object, object_id: old.object_id })).toBeUndefined();
      expect(store.createProposal(f.change)).toEqual(old);
      expect(store.claimWorkerItem({ workerId: "restarted", executionMode: "supervised_worker" })).toBeUndefined();
      expect(store.receipts(old.proposal_id)).toHaveLength(1);
    } finally { store.close(); }
  });
});

function observation(store: ProposalStore, id: string) {
  const a = store.assessBlockedWorkerClosure(id);
  expect(a.status).toBe("source_check_required");
  return { assessment_digest: a.assessment_digest, source_binding_digest: a.source_binding_digest!, state: "absent" as const };
}
async function closure(store: ProposalStore, f: Awaited<ReturnType<typeof blocked>>) {
  const source = observation(store, f.proposal.proposal_id), reason = "Resolve proven failed work; no retry or refund";
  const a = store.assessBlockedWorkerClosure(f.proposal.proposal_id, source);
  expect(a.status).toBe("available");
  const identity = await operator(f.proposal, "worker_discard", blockedClosureDecisionReason(a.assessment_digest, reason));
  return { proposalId: f.proposal.proposal_id, assessment_digest: a.assessment_digest, source, identity, reason };
}
function snapshot(store: ProposalStore) { return store.sharedLedgerEntries(); }

describe("producer-attested blocked closure (derived store evidence, signed operators)", () => {
  it("does not declare unavailable work closed, failed or unable to retry in the preview", async () => {
    const s = new ProposalStore(); try {
      const f = await blocked(s);
      const lines = blockedClosureLines(s.assessBlockedWorkerClosure(f.proposal.proposal_id)).join("\n");
      expect(lines).toContain("No closure performed. Existing proposal, receipt and worker state are unchanged.");
      expect(lines).not.toContain("Old work will never retry.");
      expect(lines).not.toContain("original proposal and failed receipt stay failed.");
    } finally { s.close(); }
  });
  it("refuses legacy W2-shaped evidence instead of interpreting zero rows/safe code as rollback proof", async () => {
    const s = new ProposalStore(); try {
      const f = await blocked(s);
      expect(s.assessBlockedWorkerClosure(f.proposal.proposal_id)).toMatchObject({ status: "unavailable", code: "BLOCKED_CLOSURE_PRODUCER_EVIDENCE_MISSING" });
    } finally { s.close(); }
  });
  it("previews without mutation; closes once, survives restart, preserves failed bytes, approval, job and old replay", async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), "closure-ledger-")); dirs.push(d); const file = path.join(d, "local.db");
    let s = new ProposalStore(file);
    try {
      const f = await blocked(s, true), before = snapshot(s), input = await closure(s, f);
      expect(snapshot(s)).toEqual(before); // preview/decline has no effect
      expect(blockedClosureLines(s.assessBlockedWorkerClosure(input.proposalId, input.source)).join("\n")).toContain("no refund");
      const original = { p: s.getProposal(input.proposalId), a: s.approvals(input.proposalId), r: s.receipts(input.proposalId), j: s.listWritebackJobs() };
      expect(s.closeBlockedWorkerItem(input)).toMatchObject({ status: "closed" });
      const closed = snapshot(s);
      for (const changed of [ { ...input, assessment_digest: canonicalJsonDigest("other") },
        { ...input, reason: "different reason" }, { ...input, source: { ...input.source, source_binding_digest: canonicalJsonDigest("other") } } ]) {
        expect(() => s.closeBlockedWorkerItem(changed)).toThrowError(expect.objectContaining({ code: "BLOCKED_CLOSURE_CONFIRMATION_MISMATCH" }));
        expect(snapshot(s)).toEqual(closed);
      }

      expect(s.closeBlockedWorkerItem(input)).toMatchObject({ status: "closed" }); expect(snapshot(s)).toEqual(closed);
      s.close(); s = new ProposalStore(file);
      expect(s.closeBlockedWorkerItem(input)).toMatchObject({ status: "closed" });
      expect({ p: s.getProposal(input.proposalId), a: s.approvals(input.proposalId), r: s.receipts(input.proposalId), j: s.listWritebackJobs() }).toEqual(original);
      expect(s.events(input.proposalId).filter(e => e.kind === "writeback_blocked_closed")).toHaveLength(1);
      expect(s.getWorkerQueueItem(input.proposalId)).toMatchObject({ status: "discarded", attempts: 1 });
      expect(s.claimWorkerItem({ workerId: "restart", executionMode: "supervised_worker" })).toBeUndefined();
      expect(s.createProposal(f.change)).toEqual(original.p);
      expect(() => s.createWritebackJobFromProposal(input.proposalId)).toThrow();
      expect(() => s.requeueDeadLetter({ proposalId: input.proposalId, retryBudget: 1, identity: input.identity })).toThrow();
    } finally { s.close(); }
  });
  it.each(["lease", "earlier_attempt", "missing_receipt", "contradictory_receipt", "missing_producer", "wrong_job", "wrong_store", "unknown_intent"])("refuses %s without partial mutation", async kind => {
    const s = new ProposalStore(); try {
      const f = await blocked(s, true), id = f.proposal.proposal_id;
      if (kind === "lease") s.db.prepare("UPDATE worker_queue SET lease_id='live' WHERE proposal_id=?").run(id);
      if (kind === "earlier_attempt") s.db.prepare("UPDATE worker_queue SET attempts=2 WHERE proposal_id=?").run(id);
      if (kind === "missing_receipt") s.db.prepare("DELETE FROM writeback_receipts WHERE proposal_id=?").run(id);
      if (kind === "contradictory_receipt") s.db.prepare("UPDATE proposals SET source_database_mutated=1 WHERE proposal_id=?").run(id);
      if (kind === "missing_producer") s.db.prepare("DELETE FROM proposal_events WHERE kind='writeback_source_rollback'").run();
      if (kind === "wrong_job") s.db.prepare("UPDATE writeback_jobs SET status='applied'").run();
      if (kind === "wrong_store") s.db.prepare("UPDATE control_policy_identity SET repository_id='other'").run();
      if (kind === "unknown_intent") s.db.prepare("UPDATE worker_queue SET status='reconciliation_required'").run();
      const before = snapshot(s);
      expect(s.assessBlockedWorkerClosure(id).status).toBe("unavailable"); expect(snapshot(s)).toEqual(before);
    } finally { s.close(); }
  });
  it.each(["present", "unavailable"] as const)("source %s refuses; current business rows are never used as proof", async state => {
    const s = new ProposalStore(); try { const f = await blocked(s, true), obs = observation(s, f.proposal.proposal_id);
      expect(s.assessBlockedWorkerClosure(f.proposal.proposal_id, { ...obs, state }).status).toBe("unavailable");
    } finally { s.close(); }
  });
  it.each(["unverified", "wrong_role", "tampered_preview", "changed_source", "wrong_reason", "drift"])("refuses %s at definitive transaction", async kind => {
    const s = new ProposalStore(); try { const f = await blocked(s, true), input = await closure(s, f);
      if (kind === "unverified") input.identity.verified = false;
      if (kind === "wrong_role") input.identity = await operator(f.proposal, "worker_discard", input.identity.decision.reason, ["other"]);
      if (kind === "tampered_preview") input.assessment_digest = canonicalJsonDigest("other");
      if (kind === "changed_source") input.source.source_binding_digest = canonicalJsonDigest("other");
      if (kind === "wrong_reason") input.reason = "different";
      if (kind === "drift") s.db.prepare("UPDATE worker_queue SET updated_at='2099-01-01'").run();
      const before = snapshot(s); expect(() => s.closeBlockedWorkerItem(input)).toThrow(); expect(snapshot(s)).toEqual(before);
    } finally { s.close(); }
  });
  it("rolls back the queue transition when event persistence fails, then independent handles acknowledge one close", async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), "closure-race-")); dirs.push(d); const file = path.join(d, "local.db");
    const s = new ProposalStore(file), second = new ProposalStore(file);
    try { const f = await blocked(s, true), input = await closure(s, f), before = snapshot(s);
      s.db.exec("CREATE TRIGGER fail_closure BEFORE INSERT ON proposal_events WHEN NEW.kind='writeback_blocked_closed' BEGIN SELECT RAISE(ABORT, 'injected closure save failure'); END");
      expect(() => s.closeBlockedWorkerItem(input)).toThrow("injected closure save failure"); expect(snapshot(s)).toEqual(before);
      s.db.exec("DROP TRIGGER fail_closure");
      s.db.exec("CREATE TRIGGER no_closure BEFORE UPDATE ON worker_queue WHEN NEW.status='discarded' BEGIN SELECT RAISE(IGNORE); END");
      expect(() => s.closeBlockedWorkerItem(input)).toThrowError(expect.objectContaining({ code: "BLOCKED_CLOSURE_PREVIEW_CHANGED" }));
      expect(snapshot(s)).toEqual(before); s.db.exec("DROP TRIGGER no_closure");

      expect(s.closeBlockedWorkerItem(input).status).toBe("closed"); expect(second.closeBlockedWorkerItem(input).status).toBe("closed");
      expect(s.events(input.proposalId).filter(e => e.kind === "writeback_blocked_closed")).toHaveLength(1);
    } finally { s.close(); second.close(); }
  });
});


describe("closure retains real approval allowance", () => {
  it.each(["tenant", "boundary"] as const)("retains %s history; replacement consumes a separate slot or stays review-pending", async scope => {
    for (const maximum of [1, 2]) {
      const s = new ProposalStore(); try {
        const f = await blocked(s, true), input = await closure(s, f), approval = s.approvals(input.proposalId);
        s.closeBlockedWorkerItem(input);
        expect(s.approvals(input.proposalId)).toEqual(approval);
        const id = "wrp_replacement", decision = await f.fixture.decide(atomicMemoryLoader("postgres", atomicRows()), id);
        if (decision.result !== "eligible") throw new Error("fresh facts must be eligible");
        const p = s.createProposal(buildDerivedChangeSet({ decision, context: { tenant_id: "acct_1", principal: "customer_1", provenance: "static_dev" },
          proposalId: id, createdAt: f.fixture.now, evidenceBundleId: "ev_replacement", queryFingerprint: canonicalJsonDigest(id) }));
        const result = s.approveProposalByPolicy(id, { policy: "fixture_automatic", proposal_hash: p.proposal_hash, proposal_version: 1, reason: "Separate new admission",
          action_boundary: { name: "atomic.actions", digest: decision.activated.action_boundary_digest,
            limits: [{ id: "existing_allowance", kind: "count", scope, maximum, window_seconds: 86400 }] } });
        expect(result.approved).toBe(maximum === 2);
        expect(s.getProposal(id)!.state).toBe(maximum === 2 ? "approved" : "pending_review");
        if (maximum === 1) expect(result.tripped_limits).toEqual([expect.objectContaining({ observed: 1, projected: 2 })]);
        expect(s.approvals(input.proposalId)).toEqual(approval);
        expect(s.approvals(id)).toHaveLength(maximum === 2 ? 1 : 0);
        expect(s.findActiveProposal({ tenant_id: p.tenant_id, action: p.action, business_object: p.business_object, object_id: p.object_id })?.proposal_id).toBe(id);
      } finally { s.close(); }
    }
  });
});

// Explicit native PostgreSQL CONTROL-store gate. Seed entries are generated by
// real lifecycle operations above; this is backend fixture evidence, not a public
// setup/execution result. No historical queue is loaded or executed.
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { PostgresProposalRuntimeStore, migrateSharedPostgresRuntimeStore, bindBlockedClosureBridge } from "@synapsor-runner/proposal-store";
const pgUrl = process.env.SYNAPSOR_TEST_POSTGRES_URL;
async function pgFixture(run: (f: { pool: Pool; schema: string; input: Awaited<ReturnType<typeof closure>>; native: PostgresProposalRuntimeStore }) => Promise<void>) {
  const pool = new Pool({ connectionString: pgUrl, max: 6, connectionTimeoutMillis: 3000, statement_timeout: 10000 });
  const schema = `closure_${randomBytes(6).toString("hex")}`, s = new ProposalStore();
  try {
    await migrateSharedPostgresRuntimeStore(pool, schema, 2000);
    const native = new PostgresProposalRuntimeStore({ pool, schema, lockTimeoutMs: 2000 });
    const repository_id = await native.controlPolicies.initialize();
    await native.controlPolicies.importDeployment({ deployment_id: "closure", project_id: "closure_project", migration_digest: canonicalJsonDigest("closure"), revisions: [], active: [],
      event: { event_id: "closure_import", actor: "fixture_owner", occurred_at: new Date().toISOString(), receipt: {} } });
    const unbind = bindBlockedClosureBridge(s.path, { repository_id, deployment_id: "closure", project_id: "closure_project" });
    let input: Awaited<ReturnType<typeof closure>>;
    try {
      const f = await blocked(s, true); input = await closure(s, f);
      for (const e of s.sharedLedgerEntries()) await pool.query(`INSERT INTO "${schema}".ledger_entries (entry_key,kind,proposal_id,tenant_id,capability,payload_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [e.entry_key, e.kind, e.proposal_id ?? null, e.tenant_id ?? null, e.capability ?? null, JSON.stringify(e.payload), e.created_at]);
    } finally { unbind(); }
    expect(await native.assessBlockedWorkerClosure(input.proposalId, input.source)).toMatchObject({ status: "available", assessment_digest: input.assessment_digest });
    await run({ pool, schema, input, native });
  } finally { s.close(); try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } }
}

describe.skipIf(!pgUrl)("native PostgreSQL control-store blocked closure", () => {
  it("observes only the exact receipt namespace; applied, in-progress, wrong destination and filtered absence refuse", async () => pgFixture(async f => {
    const namespace = { schema: f.schema, table: "closure_receipts" };
    await f.pool.query(`CREATE TABLE "${f.schema}".closure_receipts (idempotency_key text, job_id text, proposal_id text, status text)`);
    const binding = sourceRollbackBinding({ databaseUrl: pgUrl!, engine: "postgres", sourceId: "fixture_source",
      receipts: { authority: "source_db", provisioning: "precreated", ...namespace } })!;
    const assessment = await f.native.assessBlockedWorkerClosure(f.input.proposalId);
    const input = { assessment: { ...assessment, source_binding_digest: binding }, job: { source_id: "fixture_source", idempotency_key: "exact_attempt" },
      producer: { writer_reference: "OWNED_WRITER", receipt_namespace: namespace }, env: { OWNED_WRITER: pgUrl } };
    expect(await inspectBlockedClosureSource(input)).toMatchObject({ state: "absent", source_binding_digest: binding });
    for (const status of ["in_progress", "applied"]) {
      await f.pool.query(`INSERT INTO "${f.schema}".closure_receipts VALUES ('exact_attempt','job','proposal',$1)`, [status]);
      expect(await inspectBlockedClosureSource(input)).toMatchObject({ state: "present" });
      await f.pool.query(`DELETE FROM "${f.schema}".closure_receipts`);
    }
    expect(await inspectBlockedClosureSource({ ...input, env: {} })).toMatchObject({ state: "unavailable" });
    expect(await inspectBlockedClosureSource({ ...input, assessment: { ...input.assessment, source_binding_digest: canonicalJsonDigest("wrong destination") } })).toMatchObject({ state: "unavailable" });
    await f.pool.query(`ALTER TABLE "${f.schema}".closure_receipts ENABLE ROW LEVEL SECURITY`);
    expect(await inspectBlockedClosureSource(input)).toMatchObject({ state: "unavailable" });
  }));

  it.each(["tenant", "boundary"] as const)("keeps %s consumption in the native accounting transaction", async scope => {
    for (const maximum of [1, 2]) await pgFixture(async f => {
      const old = (await f.native.getProposal(f.input.proposalId))!;
      expect(await semanticRequestLifecycle(f.native, old)).toMatchObject({ approval: "automatic", execution: "held", sourceChanged: false,
        lifecycle: { execution: "failed", disposition: "blocked", automatic_retry_scheduled: false } });
      await f.native.closeBlockedWorkerItem(f.input);
      const history = await f.pool.query(`SELECT * FROM "${f.schema}".ledger_entries ORDER BY entry_key`);
      expect(await semanticRequestLifecycle(f.native, old)).toMatchObject({ approval: "automatic", execution: "held", sourceChanged: false,
        lifecycle: { execution: "failed", disposition: "closed", automatic_retry_scheduled: false } });
      expect((await f.pool.query(`SELECT * FROM "${f.schema}".ledger_entries ORDER BY entry_key`)).rows).toEqual(history.rows);
      const fixture = atomicFixture("postgres"), id = "wrp_pg_replacement";
      const decision = await fixture.decide(atomicMemoryLoader("postgres", atomicRows()), id);
      if (decision.result !== "eligible") throw new Error("Eligible replacement required");
      const proposal = await f.native.createProposal(buildDerivedChangeSet({ decision, context: { tenant_id: "acct_1", principal: "customer_1", provenance: "static_dev" },
        proposalId: id, createdAt: fixture.now, evidenceBundleId: "ev_pg_replacement", queryFingerprint: canonicalJsonDigest(id) }));
      const result = await f.native.approveProposalByPolicy(id, { policy: "fixture_automatic", proposal_hash: proposal.proposal_hash, proposal_version: 1, reason: "New admission after administrative closure",
        action_boundary: { name: "atomic.actions", digest: decision.activated.action_boundary_digest,
          limits: [{ id: "existing_allowance", kind: "count", scope, maximum, window_seconds: 86400 }] } });
      expect(result.approved).toBe(maximum === 2);
      expect((await f.native.getProposal(id))!.state).toBe(maximum === 2 ? "approved" : "pending_review");
      if (maximum === 1) expect(result.tripped_limits).toEqual([expect.objectContaining({ observed: 1, projected: 2 })]);
      expect(await f.native.getWorkerQueueItem(f.input.proposalId)).toMatchObject({ status: "discarded", attempts: 1 });
    });
  });

  it("competing handles really wait for the writer lock, then commit one terminal closure", async () => pgFixture(async f => {
    const held = await f.pool.connect();
    await held.query("BEGIN"); await held.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`synapsor-runner:${f.schema}:runtime-store`]);
    const waiting = new Set<unknown>(); let wake!: () => void;
    const observed = new Promise<void>(resolve => { wake = resolve; });
    const tracked = { query: f.pool.query.bind(f.pool), connect: async () => {
      const c = await f.pool.connect(); return { release: () => c.release(), query: async (sql: string, args?: unknown[]) => {
        const r = await c.query(sql, args); if (sql.includes("pg_try_advisory_xact_lock") && r.rows[0]?.locked === false) { waiting.add(c); if (waiting.size >= 2) wake(); } return r;
      } };
    } };
    const a = new PostgresProposalRuntimeStore({ pool: tracked, schema: f.schema, lockTimeoutMs: 2000 });
    const b = new PostgresProposalRuntimeStore({ pool: tracked, schema: f.schema, lockTimeoutMs: 2000 });
    const p = Promise.all([a.closeBlockedWorkerItem(f.input), b.closeBlockedWorkerItem(f.input)]);
    const worker = f.native.claimWorkerItem({ workerId: "restarted_worker", executionMode: "supervised_worker" });
    try { await observed; expect((await f.native.getWorkerQueueItem(f.input.proposalId))!.status).toBe("blocked"); }
    finally { await held.query("ROLLBACK"); held.release(); }
    expect((await p).map(x => x.status)).toEqual(["closed", "closed"]);
    expect(await worker).toBeUndefined();
    expect(await new PostgresProposalRuntimeStore({ pool: f.pool, schema: f.schema }).claimWorkerItem({ workerId: "later_restart", executionMode: "supervised_worker" })).toBeUndefined();
    const events = (await f.pool.query(`SELECT payload_json FROM "${f.schema}".ledger_entries WHERE kind='proposal_event' AND payload_json->>'kind'='writeback_blocked_closed'`)).rows;
    expect(events).toHaveLength(1);
    expect(await f.native.getWorkerQueueItem(f.input.proposalId)).toMatchObject({ status: "discarded", attempts: 1 });
  }));
  it("persistence failure rolls back every shared entry; lost COMMIT acknowledgement replays the exact durable closure", async () => pgFixture(async f => {
    await f.pool.query(`CREATE FUNCTION "${f.schema}".fail_close() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload_json->>'kind'='writeback_blocked_closed' THEN RAISE EXCEPTION 'injected closure persistence failure'; END IF; RETURN NEW; END $$`);
    await f.pool.query(`CREATE TRIGGER reject_close BEFORE INSERT OR UPDATE ON "${f.schema}".ledger_entries FOR EACH ROW EXECUTE FUNCTION "${f.schema}".fail_close()`);
    await expect(f.native.closeBlockedWorkerItem(f.input)).rejects.toThrow("injected closure persistence failure");
    expect(await f.native.getWorkerQueueItem(f.input.proposalId)).toMatchObject({ status: "blocked", attempts: 1 });
    await f.pool.query(`DROP TRIGGER reject_close ON "${f.schema}".ledger_entries`);
    let lost = false;
    const unreliable = { query: f.pool.query.bind(f.pool), connect: async () => {
      const c = await f.pool.connect(); return { release: () => c.release(), query: async (sql: string, args?: unknown[]) => {
        const r = await c.query(sql, args); if (sql === "COMMIT" && !lost) { lost = true; throw new Error("injected lost acknowledgement after committed closure"); } return r;
      } };
    } };
    await expect(new PostgresProposalRuntimeStore({ pool: unreliable, schema: f.schema }).closeBlockedWorkerItem(f.input)).rejects.toThrow("lost acknowledgement");
    expect(await f.native.closeBlockedWorkerItem(f.input)).toMatchObject({ status: "closed", assessment_digest: f.input.assessment_digest });
    await expect(f.native.closeBlockedWorkerItem({ ...f.input, reason: "altered repeat" })).rejects.toMatchObject({ code: "BLOCKED_CLOSURE_CONFIRMATION_MISMATCH" });
  }));
});
