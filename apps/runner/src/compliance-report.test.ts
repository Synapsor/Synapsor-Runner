import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { createComplianceReport, formatComplianceReport, readComplianceReport, verifyComplianceReport } from "./compliance-report.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))));

describe("compliance reports", () => {
  it("exports scoped metadata without evidence rows and verifies JSON, Markdown, and PDF digests", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-report-"));
    directories.push(directory);
    const storePath = path.join(directory, "ledger.db");
    seed(storePath);
    const report = await createComplianceReport({
      storePath,
      scope: { kind: "object", tenant_id: "tenant-a", object_type: "invoice", object_id: "INV-1" },
      generatedAt: "2026-07-14T00:00:00.000Z",
    });
    expect(report.entries.some((entry) => entry.category === "proposal")).toBe(true);
    expect(report.entries.some((entry) => entry.category === "evidence")).toBe(true);
    expect(report.entries.map((entry) => entry.category)).toEqual(expect.arrayContaining(["policy_recommendation", "policy_decision", "policy_artifact"]));
    expect(JSON.stringify(report)).not.toContain("never-export-this-private-note");
    expect(JSON.stringify(report)).not.toContain("/home/synthetic-private-review");
    expect(report.entries.filter((entry) => entry.category === "event").every((entry) => entry.details.payload_included === false)).toBe(true);
    expect(report.entries.find((entry) => entry.category === "evidence")?.details).toMatchObject({ row_payload_included: false });

    for (const format of ["json", "markdown", "pdf"] as const) {
      const file = path.join(directory, `report.${format === "markdown" ? "md" : format}`);
      await fs.writeFile(file, await formatComplianceReport(report, format));
      expect(await verifyComplianceReport(await readComplianceReport(file))).toEqual({ ok: true, digest_ok: true, code: "REPORT_DIGEST_VERIFIED" });
    }
  });

  it("detects content tampering and verifies optional operator signatures", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-report-sign-"));
    directories.push(directory);
    const storePath = path.join(directory, "ledger.db");
    seed(storePath);
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const privatePath = path.join(directory, "operator.pem");
    const publicPath = path.join(directory, "operator.pub.pem");
    await fs.writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }));
    await fs.writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }));
    const report = await createComplianceReport({
      storePath,
      scope: { kind: "principal", tenant_id: "tenant-a", principal: "agent-a" },
      signingKeyPath: privatePath,
      signingKeyId: "review-key-1",
      generatedAt: "2026-07-14T00:00:00.000Z",
    });
    expect(await verifyComplianceReport(report)).toMatchObject({ ok: false, digest_ok: true, code: "REPORT_PUBLIC_KEY_REQUIRED" });
    expect(await verifyComplianceReport(report, publicPath)).toMatchObject({ ok: true, signature_ok: true, code: "REPORT_SIGNATURE_VERIFIED" });
    report.entries[0]!.details.state = "tampered";
    expect(await verifyComplianceReport(report, publicPath)).toMatchObject({ ok: false, digest_ok: false, code: "REPORT_DIGEST_MISMATCH" });
  });

  it("does not cross tenant or principal scope", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-report-scope-"));
    directories.push(directory);
    const storePath = path.join(directory, "ledger.db");
    seed(storePath);
    const report = await createComplianceReport({ storePath, scope: { kind: "principal", tenant_id: "tenant-b", principal: "agent-a" }, generatedAt: "2026-07-14T00:00:00.000Z" });
    expect(report.entries).toEqual([]);
  });
});

function seed(storePath: string): void {
  const store = new ProposalStore(storePath);
  try {
    store.createProposal({
      schema_version: "synapsor.change-set.v1",
      proposal_id: "wrp_report_1",
      proposal_version: 1,
      action: "billing.propose_waiver",
      mode: "review_required",
      principal: { id: "agent-a", source: "trusted_session" },
      scope: { tenant_id: "tenant-a", business_object: "invoice", object_id: "INV-1" },
      source: { kind: "external_postgres", source_id: "billing", schema: "public", table: "invoices", primary_key: { column: "id", value: "INV-1" } },
      before: { late_fee_cents: 2500 },
      patch: { late_fee_cents: 0 },
      after: { late_fee_cents: 0 },
      guards: { tenant: { column: "tenant_id", value: "tenant-a" }, allowed_columns: ["late_fee_cents"], expected_version: { column: "updated_at", value: "v1" } },
      evidence: { bundle_id: "ev_report_1", query_fingerprint: "sha256:evidence-report", items: [] },
      approval: { status: "pending", required_role: "reviewer" },
      writeback: { status: "not_applied", mode: "trusted_worker_required" },
      source_database_mutated: false,
      integrity: { proposal_hash: "sha256:proposal-report" },
      created_at: "2026-07-14T00:00:00.000Z",
    });
    store.recordEvidenceBundle({
      evidence_bundle_id: "ev_report_1",
      proposal_id: "wrp_report_1",
      tenant_id: "tenant-a",
      payload: { principal: "agent-a", capability: "billing.propose_waiver", business_object: "invoice", object_id: "INV-1", query_fingerprint: "sha256:evidence-report" },
      items: [{ id: "INV-1", private_notes: "never-export-this-private-note" }],
    });
    store.recordQueryAudit({ proposal_id: "wrp_report_1", evidence_bundle_id: "ev_report_1", source_id: "billing", query_fingerprint: "sha256:evidence-report", table_name: "invoices", row_count: 1, payload: { principal: "agent-a", capability: "billing.propose_waiver", business_object: "invoice", object_id: "INV-1" } });
    store.approveProposal("wrp_report_1", { approver: "human-reviewer", proposal_hash: "sha256:proposal-report", proposal_version: 1, reason: "reviewed at /home/synthetic-private-review" });
    const recommendation = store.createPolicyRecommendation({
      tenant_id: "tenant-a",
      capability: "billing.propose_waiver",
      policy: "billing_low_risk",
      field: "late_fee_cents",
      base_contract_digest: canonicalJsonDigest({ contract: "base" }),
      base_contract_version: "1",
      current_threshold: 2500,
      proposed_threshold: 3000,
      maximum_increment: 500,
      absolute_ceiling: 5000,
      criteria: { minimum_human_reviews: 10 },
      metrics: {
        window_start: "2026-06-14T00:00:00.000Z",
        window_end: "2026-07-14T00:00:00.000Z",
        human_reviewed: 10,
        human_approved: 10,
        human_rejected: 0,
        conflicts: 0,
        failures: 0,
        reverts: 0,
        auto_approved_excluded: 2,
        rejection_rate: 0,
        conflict_rate: 0,
        failure_rate: 0,
        revert_rate: 0,
      },
      evidence_proposal_ids: ["wrp_report_1"],
      explanation: ["Ten human-reviewed outcomes met the reviewed limits."],
      now: "2026-07-14T00:01:00.000Z",
    });
    const decision = {
      schema_version: "synapsor.operator-decision.v1" as const,
      action: "approve" as const,
      proposal_id: recommendation.recommendation_id,
      proposal_version: 1,
      proposal_hash: recommendation.integrity_hash,
      subject: "policy-reviewer",
      issued_at: "2026-07-14T00:02:00.000Z",
      reason: "reviewed metrics",
    };
    const identityCore = {
      provider: "signed_key" as const,
      verified: true,
      subject: "policy-reviewer",
      roles: ["policy_reviewer"],
      key_id: "policy-reviewer",
      algorithm: "SHA256",
      decision,
      decision_hash: canonicalJsonDigest(decision),
      signature: "fixture-signature",
    };
    const approved = store.decidePolicyRecommendation(recommendation.recommendation_id, {
      action: "approve",
      actor: "policy-reviewer",
      reason: "reviewed metrics",
      identity: { ...identityCore, integrity_hash: canonicalJsonDigest(identityCore) },
      now: "2026-07-14T00:02:00.000Z",
    });
    store.markPolicyRecommendationExported(approved.recommendation_id, {
      actor: "policy-reviewer",
      artifact_digest: canonicalJsonDigest({ contract: "recommended" }),
      now: "2026-07-14T00:03:00.000Z",
    });
  } finally {
    store.close();
  }
}
