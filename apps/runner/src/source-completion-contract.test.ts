import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest, parseSourceCompletionEvidence, parseWritebackJob, parseWritebackResult, type SourceCompletionEvidence } from "@synapsor-runner/protocol";
import { ProposalStore, type OperatorIdentityProof } from "@synapsor-runner/proposal-store";
import { operatorPublicKeyFingerprint, resolveAuthorizedOperatorIdentity, verifySignedOperatorProof, type OperatorIdentityConfig } from "./operator-identity.js";
import { reconciliationReceipt } from "./writeback-setup.js";
import { toExecutionReceipt } from "./writeback-domain.js";

// Native signed identity + SQLite adoption tests use a typed Source witness.
// They open no Source connection and make no physical Source-proof claim.
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "b61-contract-"));
  const store = new ProposalStore(path.join(root, "control.sqlite"));
  const config: OperatorIdentityConfig = { provider: "signed_key", roster_version: 2, apply_roles: ["source_reconciler"], operators: {} };
  for (const subject of ["reviewer", "reconciler", "apply_only"]) {
    const keys = crypto.generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    await fs.writeFile(path.join(root, subject + ".pub"), publicKey, { mode: 0o600 });
    await fs.writeFile(path.join(root, subject + ".key"), keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    config.operators![subject] = { public_key_path: subject + ".pub", public_key_fingerprint: operatorPublicKeyFingerprint(publicKey),
      roles: subject === "apply_only" ? [] : [subject === "reviewer" ? "business_reviewer" : "source_reconciler"],
      authority_kind: subject === "apply_only" ? "scoped_apply" : "legacy",
      ...(subject === "apply_only" ? { apply_outcomes: ["unit.adjust_credit"] } : {}) };
  }
  const before = { id: "credit_1", tenant_id: "unit_tenant", amount_cents: 1000, version: 7 };
  const change = { schema_version: "synapsor.change-set.v2", proposal_id: "wrp_contract", proposal_version: 1,
    action: "unit.adjust_credit", operation: "single_row_update", mode: "review_required", principal: { id: "unit_principal", source: "static_dev" },
    scope: { tenant_id: "unit_tenant", business_object: "credits", object_id: "credit_1" },
    source: { kind: "external_postgres", source_id: "unit_source", schema: "public", table: "credits", primary_key: { column: "id", value: "credit_1" } },
    before, patch: { amount_cents: 2500 }, after: { ...before, amount_cents: 2500, version: 8 },
    guards: { tenant: { column: "tenant_id", value: "unit_tenant" }, allowed_columns: ["amount_cents"], expected_version: { column: "version", value: 7 }, version_advance: { column: "version", strategy: "integer_increment" } },
    evidence: { bundle_id: "ev_contract", query_fingerprint: canonicalJsonDigest({ unit: "contract" }), items: [] },
    approval: { status: "pending", required_role: "business_reviewer" }, writeback: { status: "not_applied", mode: "trusted_worker_required", executor: "sql_update" },
    source_database_mutated: false, integrity: { proposal_hash: canonicalJsonDigest({ before, requested: 2500 }) }, created_at: new Date().toISOString() };
  const proposal = store.createProposal(change);
  const identify = async (subject: string, action: "approve" | "apply" | "reconcile", requiredRole?: string) => {
    const identity = await resolveAuthorizedOperatorIdentity({ config, configPath: path.join(root, "config.json"), proposal: store.getProposal(proposal.proposal_id)!,
      identity: subject, actor: subject, privateKeyPath: path.join(root, subject + ".key"), action, requiredRole, reason: "Native contract test", env: {} });
    expect(verifySignedOperatorProof(identity, await fs.readFile(path.join(root, subject + ".pub"), "utf8"))).toBe(true);
    return identity;
  };
  const approver = await identify("reviewer", "approve", "business_reviewer");
  store.approveProposal(proposal.proposal_id, { approver: approver.subject, proposal_hash: proposal.proposal_hash, proposal_version: 1, identity: approver, require_verified_identity: true });
  const contractDigest = canonicalJsonDigest({ unit: "worker" });
  store.enqueueWorkerProposal({ proposal_id: proposal.proposal_id, execution_mode: "supervised_worker", contract_digest: contractDigest });
  const lease = store.claimWorkerItem({ workerId: "unit_worker", executionMode: "supervised_worker", capability: proposal.action, contractDigest })!;
  const job = parseWritebackJob(store.createWritebackJobFromProposal(proposal.proposal_id));
  if (job.protocol_version !== "2.0" || job.operation !== "single_row_update") throw new Error("Native ordinary update job required");
  const body = { schema_version: "synapsor.source-completion-binding.v1" as const, job_digest: canonicalJsonDigest(job), source_binding_digest: canonicalJsonDigest({ destination: "unit" }), execution_binding_digest: contractDigest, writer_reference: "UNIT_WRITE_URL" };
  const binding = { ...body, digest: canonicalJsonDigest(body) };
  const claim = store.claimWritebackIntent(job, "unit_worker", binding);
  if (claim.decision !== "proceed") throw new Error("Fresh native intent required");
  store.markWritebackIntentApplying(claim.intent_id, "unit_worker");
  store.requireWritebackReconciliation(claim.intent_id, "Unit lost acknowledgement", true);
  store.requireWorkerReconciliation({ proposalId: proposal.proposal_id, workerId: "unit_worker", leaseId: lease.lease_id!, errorCode: "OUTCOME_UNKNOWN" });
  const result = parseWritebackResult({ protocol_version: "2.0", job_id: job.job_id, runner_id: "unit_worker", operation: "single_row_update", receipt_authority: "source_db",
    status: "applied", affected_rows: 1, target_identity: [{ column: "id", value: "credit_1" }], result_version: 8,
    after_digest: canonicalJsonDigest({ unit: "native result" }), completed_at: "2026-10-08T00:00:00Z" });
  const evidence: SourceCompletionEvidence = { schema_version: "synapsor.postgres.source-completion.v1", job_digest: canonicalJsonDigest(job), binding_digest: binding.digest, result, result_digest: canonicalJsonDigest(result) };
  const unknown = parseWritebackResult({ ...result, status: "reconciliation_required", affected_rows: 0, intent_id: claim.intent_id });
  store.recordExecutionReceipt(toExecutionReceipt(job, unknown, false));
  const snapshot = () => JSON.parse(JSON.stringify({ intent: store.getWritebackIntent(claim.intent_id), proposal: store.getProposal(proposal.proposal_id), receipts: store.receipts(proposal.proposal_id),
    events: store.events(proposal.proposal_id), queue: store.getWorkerQueueItem(proposal.proposal_id), metrics: store.operationalMetrics(), job: store.getWritebackJob(job.job_id) }));
  const adoptWithIdentity = (candidate: SourceCompletionEvidence, identity: OperatorIdentityProof) => {
    const observation = { operation: job.operation, classification: "completion_proven" as const, target_identity: [{ column: "id", value: "credit_1" }], expected: {}, observed: {}, observed_digest: canonicalJsonDigest(candidate), source_completion: { status: "proven" as const, evidence: candidate } };
    const receipt = reconciliationReceipt(store.getWritebackIntent(claim.intent_id)!, observation, "applied", identity.subject, "Native contract test");
    return store.reconcileWritebackIntent({ intent_id: claim.intent_id, receipt, source_completion: candidate, actor: identity.subject, reason: "Native contract test", observation, identity, require_verified_identity: true });
  };
  const adopt = async (candidate = evidence, subject = "reconciler") => adoptWithIdentity(candidate, await identify(subject, "reconcile", "source_reconciler"));
  return { root, store, config, identify, job, binding, evidence, snapshot, adopt, adoptWithIdentity };
}

describe("Source completion remaining contract limits", () => {
  it("rejects a genuinely signed APPLY-only actor and changed current signing identity before adoption", async () => {
    const f = await fixture();
    try {
      const before = f.snapshot();
      const apply = await f.identify("apply_only", "apply");
      expect(apply.decision.action).toBe("apply");
      expect(() => f.adoptWithIdentity(f.evidence, apply)).toThrowError(expect.objectContaining({ code: "OPERATOR_DECISION_MISMATCH" }));
      expect(f.snapshot()).toEqual(before);
      await expect(f.adopt(f.evidence, "apply_only")).rejects.toMatchObject({ code: "OPERATOR_SCOPED_APPLY_NOT_AUTHORIZED" });
      expect(f.snapshot()).toEqual(before);
      await f.identify("reconciler", "reconcile", "source_reconciler");
      const original = await fs.readFile(path.join(f.root, "reconciler.pub"));
      const changed = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
      await fs.writeFile(path.join(f.root, "reconciler.pub"), changed, { mode: 0o600 });
      await expect(f.adopt()).rejects.toMatchObject({ code: "OPERATOR_PUBLIC_KEY_CHANGED" });
      expect(f.snapshot()).toEqual(before);
      await fs.writeFile(path.join(f.root, "reconciler.pub"), original, { mode: 0o600 });
      f.config.operators!.reconciler!.roles = ["business_reviewer"];
      await expect(f.adopt()).rejects.toThrow("lacks required role source_reconciler");
      expect(f.snapshot()).toEqual(before);
    } finally { f.store.close(); }
  });

  it("refuses foreign whole jobs and result effects, then preserves proven completion against a conflicting envelope", async () => {
    const f = await fixture();
    try {
      const before = f.snapshot();
      for (const changed of [{ ...f.job, source_id: "foreign_source" }, { ...f.job, target: { ...f.job.target, tenant_guard: { column: "tenant_id", value: "foreign_tenant" } } },
        { ...f.job, job_id: "foreign_job" }, { ...f.job, patch: { amount_cents: 9900 } }]) {
        await expect(f.adopt({ ...f.evidence, job_digest: canonicalJsonDigest(changed) })).rejects.toThrow();
        expect(f.snapshot()).toEqual(before);
      }
      for (const result of [parseWritebackResult({ ...f.evidence.result, result_version: 9 }), parseWritebackResult({ ...f.evidence.result, target_identity: [{ column: "id", value: "foreign_credit" }] })]) {
        await expect(f.adopt({ ...f.evidence, result, result_digest: canonicalJsonDigest(result) })).rejects.toThrow("SOURCE_COMPLETION_PROOF_INVALID");
        expect(f.snapshot()).toEqual(before);
      }
      expect((await f.adopt()).status).toBe("applied");
      const applied = f.snapshot();
      const conflict = parseWritebackResult({ ...f.evidence.result, completed_at: "2026-10-08T00:00:01Z" });
      await expect(f.adopt({ ...f.evidence, result: conflict, result_digest: canonicalJsonDigest(conflict) })).rejects.toMatchObject({ code: "SOURCE_COMPLETION_QUEUE_NOT_QUARANTINED" });
      expect(f.snapshot()).toEqual(applied);
      expect(applied.events.filter((event: { kind: string }) => event.kind === "writeback_reconciled")).toHaveLength(1);
    } finally { f.store.close(); }
  });

  it("validates every atomic effect of the accepted native Source witness without touching its saved history", async () => {
    const root = process.env.SYNAPSOR_B61_READONLY_NATIVE_WITNESS;
    if (!root?.startsWith("/var/tmp/synapsor-b61-recovery-owned-recovery-luna-v2-")) throw new Error("Exact accepted read-only native witness required");
    const files = ["fresh-job.json", "cold-inspect.json", "before-actual-source.json", "after-recovery-actual-source.json"];
    const original = await Promise.all(files.map(name => fs.readFile(path.join(root, name), "utf8")));
    const job = parseWritebackJob(JSON.parse(original[0]!));
    const capture = JSON.parse(original[1]!);
    const evidence = capture.result.completion.evidence as SourceCompletionEvidence;
    const binding = capture.result.intent.source_completion_binding;
    expect(parseSourceCompletionEvidence(evidence, job, binding)).toEqual(evidence);
    for (const mutate of [
      (result: Record<string, any>) => { result.atomic_effects[1].effect_digest = canonicalJsonDigest({ foreign: "effect" }); },
      (result: Record<string, any>) => { result.atomic_effects[1].schema = "foreign_schema"; },
      (result: Record<string, any>) => { result.atomic_effects[1].target_identity[0].value = "foreign_offer"; },
      (result: Record<string, any>) => { result.semantic_verification.proof_digest = canonicalJsonDigest({ foreign: "proof" }); },
    ]) {
      const changed = structuredClone(evidence); mutate(changed.result);
      changed.result_digest = canonicalJsonDigest(changed.result);
      expect(() => parseSourceCompletionEvidence(changed, job, binding)).toThrow("SOURCE_COMPLETION_PROOF_INVALID");
    }
    expect(await Promise.all(files.map(name => fs.readFile(path.join(root, name), "utf8")))).toEqual(original);
  });
});
