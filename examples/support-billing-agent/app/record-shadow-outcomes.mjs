import { createShadowOutcomeRecorder } from "@synapsor/runner/shadow";

const [storePath, studyId] = process.argv.slice(2);
if (!storePath || !studyId) {
  throw new Error("usage: node record-shadow-outcomes.mjs <store-path> <study-id>");
}

const recorder = createShadowOutcomeRecorder({
  storePath,
  studyId,
  actor: "support_reference_app",
  source: "support-app-audit",
});
try {
  recorder.record({
    requestId: "req-waiver-exact",
    tenantId: "acme",
    businessObject: "invoice",
    objectId: "INV-3001",
    disposition: "applied",
    actualEffect: {
      before: { late_fee_cents: 5500, waiver_reason: null },
      after: { late_fee_cents: 0, waiver_reason: "courtesy waiver" },
      patch: { late_fee_cents: 0, waiver_reason: "courtesy waiver" },
    },
    occurredAt: "2026-07-19T11:00:00.000Z",
    reference: "ticket:SUP-184",
    reason: "customer qualified",
  });
  recorder.record({
    requestId: "req-waiver-rejected",
    tenantId: "acme",
    businessObject: "invoice",
    objectId: "INV-REJECTED",
    disposition: "rejected_no_action",
    occurredAt: "2026-07-19T11:01:00.000Z",
    reference: "ticket:SUP-REJECTED",
    reason: "customer already received a courtesy waiver",
  });
} finally {
  recorder.close();
}

process.stdout.write("Recorded 2 authoritative outcomes through @synapsor/runner/shadow.\n");
