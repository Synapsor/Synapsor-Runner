// Explicit backend gate; fixtures use normal lifecycle methods, not historical queues.
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveOperatorIdentity } from "../../../apps/runner/src/operator-identity.js";
import { semanticAtomicEffectResult, sourceRollbackBinding } from "@synapsor-runner/worker-core";
import { blockedClosureLines, inspectBlockedClosureSource } from "../../../apps/runner/src/worker-blocked-closure.js";
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
import { afterEach, describe, expect, it } from "vitest";
import { ProposalStore, blockedClosureDecisionReason, type OperatorDecision, type StoredProposal } from "@synapsor-runner/proposal-store";
import { atomicFixture, atomicMemoryLoader, atomicRows } from "../../../packages/action-rules/src/testing/atomic-fixture.js";
import { buildDerivedChangeSet } from "../../../packages/mcp-server/src/proposal-builder.js";
import { canonicalJsonDigest, parseWritebackJob } from "@synapsor-runner/protocol";
import { toExecutionReceipt } from "../../../apps/runner/src/writeback-domain.js";

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


import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
it("real SQLite writer contention is bounded, then competing closure/startup handles preserve one terminal result", async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "closure-sqlite-contention-")); dirs.push(d);
  const file = path.join(d, "local.db"), s = new ProposalStore(file);
  const workers: Worker[] = [];
  const code = `const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { ProposalStore } = await import(workerData.module);
      const store = new ProposalStore(workerData.file);
      parentPort.on('message', phase => {
        const started = Date.now();
        try {
          const result = workerData.operation === 'close' ? store.closeBlockedWorkerItem(workerData.input)
            : store.claimWorkerItem({workerId:'restarted_worker', executionMode:'supervised_worker'});
          parentPort.postMessage({phase, status: result?.status ?? 'empty', ms:Date.now()-started});
        } catch (e) { parentPort.postMessage({phase, status:'refused', code:e.code, errcode:e.errcode, message:e.message, ms:Date.now()-started}); }
      });
      parentPort.postMessage({phase:'ready'});
    })().catch(e => { throw e; });`;
  try {
    const f = await blocked(s, true), input = await closure(s, f), before = snapshot(s);
    const messages: Array<Array<Record<string, unknown>>> = [];
    const waiters = new Map<string, (x: Record<string, unknown>) => void>();
    const wait = (i: number, phase: string) => {
      const existing = messages[i]!.find(x => x.phase === phase);
      return existing ? Promise.resolve(existing) : new Promise<Record<string, unknown>>(resolve => waiters.set(`${i}:${phase}`, resolve));
    };
    for (const [i, operation] of ["close", "close", "claim"].entries()) {
      messages[i] = [];
      const w = new Worker(code, { eval: true, workerData: { file, input, operation,
        module: fileURLToPath(new URL("../../../packages/proposal-store/dist/index.js", import.meta.url)) } });
      workers.push(w); w.on("message", m => { messages[i]!.push(m); waiters.get(`${i}:${m.phase}`)?.(m); });
    }
    await Promise.all(workers.map((_, i) => wait(i, "ready")));
    s.db.exec("BEGIN IMMEDIATE");
    let busy;
    try {
      workers.forEach(w => w.postMessage("held"));
      busy = await Promise.all(workers.map((_, i) => wait(i, "held")));
      for (const r of busy) {
        expect(r.status).toBe("refused"); expect(r.errcode).toBe(5);
        expect(r.message).toContain("database is locked"); expect(Number(r.ms)).toBeGreaterThanOrEqual(4500);
      }
      expect(snapshot(s)).toEqual(before);
    } finally { s.db.exec("ROLLBACK"); }
    workers.forEach(w => w.postMessage("released"));
    const results = await Promise.all(workers.map((_, i) => wait(i, "released")));
    expect(results.map(x => x.status)).toEqual(["closed", "closed", "empty"]);
    expect(s.events(input.proposalId).filter(e => e.kind === "writeback_blocked_closed")).toHaveLength(1);
    expect(s.getWorkerQueueItem(input.proposalId)).toMatchObject({ status: "discarded", attempts: 1 });
    expect(s.receipts(input.proposalId)).toHaveLength(1); expect(s.approvals(input.proposalId)).toHaveLength(1);
    console.log(JSON.stringify({ qualification: "derived SQLite control-store evidence, actual default writer wait; not public source execution", busy, results, closure_events: 1 }));
  } finally { await Promise.all(workers.map(w => w.terminate())); s.close(); }
}, 20000);
