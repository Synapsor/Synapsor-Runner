import { ProposalStore, type ShadowEffect, type ShadowOutcomeDisposition, type StoredShadowOutcome } from "@synapsor-runner/proposal-store";

export type AuthoritativeShadowOutcome = {
  requestId: string;
  proposalId?: string;
  tenantId: string;
  businessObject: string;
  objectId: string;
  disposition: ShadowOutcomeDisposition;
  actualEffect?: ShadowEffect;
  occurredAt?: string;
  reference?: string;
  reason?: string;
};

export type ShadowOutcomeRecorder = {
  record(outcome: AuthoritativeShadowOutcome): StoredShadowOutcome;
  close(): void;
};

/**
 * Records trusted application outcomes directly in Runner's local shadow
 * ledger. This helper never reads or mutates the application's source data.
 */
export function createShadowOutcomeRecorder(input: {
  storePath: string;
  studyId: string;
  actor: string;
  source: string;
}): ShadowOutcomeRecorder {
  if (input.storePath === ":memory:") {
    throw new Error("an app-owned shadow outcome recorder requires a durable storePath");
  }
  const store = new ProposalStore(input.storePath);
  let closed = false;
  return {
    record(outcome) {
      if (closed) throw new Error("shadow outcome recorder is closed");
      return store.recordShadowOutcome({
        study_id: input.studyId,
        request_id: outcome.requestId,
        proposal_id: outcome.proposalId,
        tenant_id: outcome.tenantId,
        business_object: outcome.businessObject,
        object_id: outcome.objectId,
        actor: input.actor,
        disposition: outcome.disposition,
        actual_effect: outcome.actualEffect,
        occurred_at: outcome.occurredAt,
        source: input.source,
        reference: outcome.reference,
        reason: outcome.reason,
      });
    },
    close() {
      if (closed) return;
      closed = true;
      store.close();
    },
  };
}

export function recordAuthoritativeShadowOutcome(input: {
  storePath: string;
  studyId: string;
  actor: string;
  source: string;
  outcome: AuthoritativeShadowOutcome;
}): StoredShadowOutcome {
  const recorder = createShadowOutcomeRecorder(input);
  try {
    return recorder.record(input.outcome);
  } finally {
    recorder.close();
  }
}

export type {
  ShadowEffect,
  ShadowOutcomeDisposition,
  StoredShadowOutcome,
} from "@synapsor-runner/proposal-store";
