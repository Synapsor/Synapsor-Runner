import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { createShadowOutcomeRecorder, recordAuthoritativeShadowOutcome } from "./shadow.js";

describe("app-owned shadow outcome helper", () => {
  it("records an authoritative application outcome without JSONL assembly", async () => {
    const storePath = await shadowFixture();
    const recorder = createShadowOutcomeRecorder({
      storePath,
      studyId: "sst_app",
      actor: "support_lead_1",
      source: "support-app-audit",
    });
    const outcome = recorder.record({
      requestId: "req_1",
      tenantId: "acme",
      businessObject: "invoice",
      objectId: "INV-1",
      disposition: "applied",
      actualEffect: {
        before: { late_fee_cents: 5500 },
        after: { late_fee_cents: 0 },
        patch: { late_fee_cents: 0 },
      },
      reference: "ticket:SUP-1",
    });
    recorder.close();
    recorder.close();

    expect(outcome).toMatchObject({
      study_id: "sst_app",
      request_id: "req_1",
      actor: "support_lead_1",
      source: "support-app-audit",
      disposition: "applied",
    });
    const store = new ProposalStore(storePath);
    try {
      expect(store.shadowStudyReport("sst_app")).toMatchObject({
        tasks_with_authoritative_outcomes: 1,
        exact_agreements: 1,
        trust_progression: {
          current_stage: "manual_review",
          insufficient_sample_size: true,
          automatic_activation: false,
        },
      });
    } finally {
      store.close();
    }
  });

  it("reuses ledger validation and fails closed on scope mismatch or secrets", async () => {
    const storePath = await shadowFixture();
    const base = {
      storePath,
      studyId: "sst_app",
      actor: "support_lead_1",
      source: "support-app-audit",
    };
    expect(() => recordAuthoritativeShadowOutcome({
      ...base,
      outcome: {
        requestId: "req_1",
        tenantId: "other-tenant",
        businessObject: "invoice",
        objectId: "INV-1",
        disposition: "rejected_no_action",
      },
    })).toThrow(/does not match a case/i);
    expect(() => recordAuthoritativeShadowOutcome({
      ...base,
      outcome: {
        requestId: "req_1",
        tenantId: "acme",
        businessObject: "invoice",
        objectId: "INV-1",
        disposition: "applied",
        actualEffect: {
          before: { note: "safe" },
          after: { note: "Bearer very-secret-credential-value" },
          patch: { note: "Bearer very-secret-credential-value" },
        },
      },
    })).toThrow(/secret/i);
  });
});

async function shadowFixture(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-shadow-helper-"));
  const storePath = path.join(directory, "local.db");
  const store = new ProposalStore(storePath);
  try {
    store.createShadowStudy({ study_id: "sst_app", name: "App outcome study" });
    store.recordShadowCase({
      study_id: "sst_app",
      request_id: "req_1",
      tenant_id: "acme",
      principal: "support-agent",
      capability: "billing.propose_late_fee_waiver",
      business_object: "invoice",
      object_id: "INV-1",
      agent_result: "proposed",
      proposed_effect: {
        before: { late_fee_cents: 5500 },
        after: { late_fee_cents: 0 },
        patch: { late_fee_cents: 0 },
      },
    });
  } finally {
    store.close();
  }
  return storePath;
}
