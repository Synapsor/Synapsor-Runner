import {
  type DatabaseSync,
  type SQLInputValue,
} from "node:sqlite";
import {
  type ChangeSet,
  type ExecutionReceipt,
  type FreshnessProofV1,
  type WritebackJob,
  type WritebackJobV1,
  type WritebackJobV2,
  type WritebackJobV3,
  type WritebackJobV4,
  type WritebackResult,
} from "@synapsor-runner/protocol";
import {
  type LocalProposalState,
  type StoredProposal,
  type ProposalEvent,
  type OperatorIdentityProof,
  type StoredApproval,
  type ApprovalProgress,
  type StoredWritebackReceipt,
  type StoredWritebackJob,
  type WritebackIntentStatus,
  type StoredWritebackIntent,
  type WritebackIntentClaim,
  type ReconcileWritebackIntentInput,
  type ProposalReplayRecord,
  type StoredEvidenceBundle,
  type QueryAuditRecordInput,
  type CloudOutboxKind,
  type CloudOutboxStatus,
  type CloudOutboxItem,
  type CloudGovernanceEvent,
  type AttentionSeverity,
  type AttentionEventType,
  type AttentionEvent,
  type RecordAttentionEventInput,
  type AttentionItemStatus,
  type AttentionItem,
  type NotificationDeliveryStatus,
  type NotificationDelivery,
  type ProposalSearchFilters,
  type EvidenceSearchFilters,
  type QueryAuditSearchFilters,
  type ExplorePrivacyReleaseInput,
  type ExplorePrivacyReleaseDecision,
  type ExploreBudgetReservationInput,
  type ExploreBudgetReservationDecision,
  type CompleteExploreBudgetReservationInput,
  type CompleteExploreBudgetReservationDecision,
  type ReceiptSearchFilters,
  type EventSearchFilters,
  type StoredShadowHumanAction,
  type ShadowAgentResult,
  type ShadowOutcomeDisposition,
  type StoredShadowStudy,
  type ShadowEffect,
  type StoredShadowCase,
  type StoredShadowOutcome,
  type ShadowStudyComparison,
  type ShadowStudyReport,
  type ShadowComparison,
  type ShadowReport,
  type StoreStats,
  type StorePruneResult,
  type OperationalMetricRow,
  type PolicyRecommendationStatus,
  type PolicyRecommendation,
  type CreatePolicyRecommendationInput,
  type FleetEventMetricRow,
  type WorkerQueueStatus,
  type WorkerExecutionMode,
  type WorkerControlState,
  type WorkerControlTarget,
  type WorkerQueueItem,
  type SharedLedgerEntry,
  type SharedLedgerImportResult,
  type CreateWritebackJobOptions,
  type ActiveProposalLookup,
  type PolicyApprovalLimit,
  type PolicyApprovalLimitTrip,
  type PolicyApprovalDecision,
  type WorkerPolicyExecutionLimits,
  type RecordHandlerWritebackJobInput,
} from "./domain-types.js";
export interface ProposalStoreSchemaMethods {
  close(): void;
  stats(): StoreStats;
  vacuum(): void;
  pruneBefore(cutoffIso: string, options?: { dryRun?: boolean }): StorePruneResult;
  migrate(): void;
}

export interface ProposalStoreSchemaInternalMethods {
  ensureSearchColumns(): void;
  ensureSearchIndexes(): void;
  ensureColumn(table: string, column: string, definition: string): void;
  backfillSearchColumns(): void;
}

export interface ProposalStoreProposalMethods {
  createProposal(input: unknown): StoredProposal;
  getProposal(proposalId: string): StoredProposal | undefined;
  findActiveProposal(input: ActiveProposalLookup): StoredProposal | undefined;
  listProposals(filters?: LocalProposalState | ProposalSearchFilters): StoredProposal[];
  countProposals(filters?: ProposalSearchFilters): number;
  listEvidenceBundles(filters?: EvidenceSearchFilters): StoredEvidenceBundle[];
  listQueryAudit(filters?: QueryAuditSearchFilters): Record<string, unknown>[];
  getQueryAudit(auditId: number): Record<string, unknown> | undefined;
  claimExplorePrivacyRelease(input: ExplorePrivacyReleaseInput): ExplorePrivacyReleaseDecision;
  claimExploreBudgetReservation(input: ExploreBudgetReservationInput): ExploreBudgetReservationDecision;
  completeExploreBudgetReservation(input: CompleteExploreBudgetReservationInput): CompleteExploreBudgetReservationDecision;
  listReceipts(filters?: ReceiptSearchFilters): StoredWritebackReceipt[];
  getReceipt(receiptId: number): StoredWritebackReceipt | undefined;
  getReplayByReplayId(replayId: string): ProposalReplayRecord;
  getStoredReplay(replayId: string): ProposalReplayRecord | undefined;
  getStoredReplayForProposal(proposalId: string): ProposalReplayRecord | undefined;
  proposalIdForEvidence(evidenceBundleId: string): string | undefined;
  recordFreshnessProof(input: unknown): FreshnessProofV1;
  latestFreshnessProof(proposalId: string): FreshnessProofV1 | undefined;
  recordFreshnessApprovalBlocked(
      proposalId: string,
      input: { proof_digest: string; safe_code: string; actor: string },
    ): void;
  approveProposal(
      proposalId: string,
      options: {
        approver: string;
        proposal_hash: string;
        proposal_version: number;
        reason?: string;
        identity?: OperatorIdentityProof;
        require_verified_identity?: boolean;
        freshness_proof_digest?: string;
      },
    ): StoredProposal;
  approveProposalByPolicy(
      proposalId: string,
      options: {
        policy: string;
        proposal_hash: string;
        proposal_version: number;
        reason: string;
        limits?: PolicyApprovalLimit[];
        now?: string;
        freshness_proof_digest?: string;
      },
    ): PolicyApprovalDecision;
  rejectProposal(
      proposalId: string,
      options: {
        actor: string;
        proposal_hash: string;
        proposal_version: number;
        reason: string;
        identity?: OperatorIdentityProof;
        require_verified_identity?: boolean;
      },
    ): StoredProposal;
  approvals(proposalId: string): StoredApproval[];
  approvalProgress(proposalId: string): ApprovalProgress;
  recordOperatorAuthorization(proposalId: string, identity: OperatorIdentityProof, requireVerifiedIdentity?: boolean): void;
  markPendingWorker(proposalId: string, proposalHash: string, proposalVersion: number): StoredProposal;
}

export interface ProposalStoreWritebackMethods {
  recordExecutionReceipt(input: unknown): StoredProposal;
  recordWritebackJob(input: unknown): WritebackJob;
  getWritebackJob(writebackJobId: string): StoredWritebackJob | undefined;
  listWritebackJobs(options?: { proposal_id?: string; limit?: number }): StoredWritebackJob[];
  claimWritebackIntent(jobInput: unknown, runnerId: string): WritebackIntentClaim;
  markWritebackIntentApplying(intentId: string, runnerId: string): void;
  completeWritebackIntent(intentId: string, resultInput: WritebackResult): void;
  requireWritebackReconciliation(intentId: string, reason: string): void;
  getWritebackIntent(intentId: string): StoredWritebackIntent | undefined;
  listWritebackIntents(options?: { status?: WritebackIntentStatus; proposal_id?: string; limit?: number }): StoredWritebackIntent[];
  reconcileWritebackIntent(input: ReconcileWritebackIntentInput): StoredWritebackIntent;
  recordHandlerWritebackJob(input: RecordHandlerWritebackJobInput): void;
  createWritebackJobFromProposal(proposalId: string, options?: CreateWritebackJobOptions): WritebackJobV1 | WritebackJobV2 | WritebackJobV3 | WritebackJobV4;
  recordEvidenceBundle(input: {
      evidence_bundle_id: string;
      proposal_id?: string;
      tenant_id: string;
      payload: Record<string, unknown>;
      items?: Record<string, unknown>[];
      query_audit?: QueryAuditRecordInput[];
      created_at?: string;
    }): void;
  recordQueryAudit(input: QueryAuditRecordInput): void;
  getEvidenceBundle(evidenceBundleId: string): StoredEvidenceBundle | undefined;
  events(proposalId: string): ProposalEvent[];
  listEvents(filters?: EventSearchFilters): ProposalEvent[];
}

export interface ProposalStoreWritebackInternalMethods {
  requireWritebackIntent(intentId: string): StoredWritebackIntent;
  recordExecutionReceiptRows(receipt: ExecutionReceipt, proposal: StoredProposal): void;
  rowToEvidenceBundle(row: unknown): StoredEvidenceBundle | undefined;
}

export interface ProposalStoreWorkerMethods {
  enqueueWorkerProposal(options: {
      proposal_id: string;
      execution_mode?: WorkerExecutionMode;
      contract_digest?: `sha256:${string}`;
      max_attempts?: number;
      queue_limit?: number;
      now?: string;
    }): WorkerQueueItem;
  enqueueApprovedForWorker(options?: {
      capability?: string;
      tenant?: string;
      maxAttempts?: number;
      limit?: number;
      now?: string;
    }): WorkerQueueItem[];
  claimWorkerItem(options: {
      workerId: string;
      leaseSeconds?: number;
      executionMode?: WorkerExecutionMode;
      capability?: string;
      tenant?: string;
      contractDigest?: `sha256:${string}`;
      maxConcurrent?: number;
      rateLimit?: {
        executions: number;
        windowSeconds: number;
      };
      proposalTtlSeconds?: number;
      policyExecution?: WorkerPolicyExecutionLimits;
      now?: string;
    }): WorkerQueueItem | undefined;
  assertWorkerPolicyExecutionLimits(input: {
      proposalId: string;
      policy: string;
      limits: PolicyApprovalLimit[];
      now?: string;
    }): void;
  assertActiveWorkerLease(options: {
      proposalId: string;
      workerId: string;
      leaseId: string;
      now?: string;
    }): WorkerQueueItem;
  renewWorkerLease(options: {
      proposalId: string;
      workerId: string;
      leaseId: string;
      leaseSeconds?: number;
      now?: string;
    }): WorkerQueueItem;
  completeWorkerItem(
      proposalId: string,
      workerId: string,
      outcome: "applied" | "already_applied" | "conflict",
      now?: string,
      leaseId?: string,
    ): WorkerQueueItem;
  retryWorkerItem(options: {
      proposalId: string;
      workerId: string;
      errorCode: string;
      retryAt: string;
      leaseId: string;
      now?: string;
    }): WorkerQueueItem;
  deadLetterWorkerItem(options: {
      proposalId: string;
      workerId: string;
      errorCode: string;
      leaseId: string;
      now?: string;
    }): WorkerQueueItem;
  blockWorkerItem(options: {
      proposalId: string;
      workerId: string;
      leaseId: string;
      errorCode: string;
      now?: string;
    }): WorkerQueueItem;
  requireWorkerReconciliation(options: {
      proposalId: string;
      workerId: string;
      leaseId: string;
      errorCode: string;
      now?: string;
    }): WorkerQueueItem;
  cancelWorkerItem(options: {
      proposalId: string;
      actor: string;
      identity?: OperatorIdentityProof;
      require_verified_identity?: boolean;
      now?: string;
    }): WorkerQueueItem;
  listWorkerQueue(status?: WorkerQueueStatus): WorkerQueueItem[];
  getWorkerQueueItem(proposalId: string): WorkerQueueItem | undefined;
  requeueDeadLetter(options: {
      proposalId: string;
      retryBudget: number;
      identity: OperatorIdentityProof;
      reason?: string;
      now?: string;
    }): WorkerQueueItem;
  discardDeadLetter(options: {
      proposalId: string;
      identity: OperatorIdentityProof;
      reason: string;
      now?: string;
    }): WorkerQueueItem;
}

export interface ProposalStoreWorkerInternalMethods {
  blockQueuedWorkerItem(
      item: WorkerQueueItem,
      actor: string,
      errorCode: string,
      now: string,
      payload?: Record<string, unknown>,
    ): void;
  workerPolicyExecutionLimitTrips(input: {
      proposal: StoredProposal;
      policy: string;
      limits: PolicyApprovalLimit[];
      now: string;
    }): PolicyApprovalLimitTrip[];
  workerQueueItem(proposalId: string): WorkerQueueItem | undefined;
  requireWorkerQueueItem(proposalId: string): WorkerQueueItem;
  assertWorkerLease(proposalId: string, workerId: string, leaseId?: string): WorkerQueueItem;
}

export interface ProposalStoreMetricsPolicyMethods {
  operationalMetrics(filters?: { tenant?: string; capability?: string }): OperationalMetricRow[];
  fleetEventMetrics(filters?: { tenant?: string; capability?: string }): FleetEventMetricRow[];
  receipts(proposalId: string): StoredWritebackReceipt[];
  replay(proposalId: string): ProposalReplayRecord;
  createPolicyRecommendation(input: CreatePolicyRecommendationInput): PolicyRecommendation;
  getPolicyRecommendation(recommendationId: string): PolicyRecommendation | undefined;
  listPolicyRecommendations(filters?: { tenant?: string; capability?: string; policy?: string; status?: PolicyRecommendationStatus }): PolicyRecommendation[];
  decidePolicyRecommendation(
      recommendationId: string,
      input: { action: "approve" | "reject"; actor: string; reason: string; identity: OperatorIdentityProof; now?: string },
    ): PolicyRecommendation;
  markPolicyRecommendationExported(recommendationId: string, input: { actor: string; artifact_digest: string; now?: string }): PolicyRecommendation;
}

export interface ProposalStoreMetricsPolicyInternalMethods {
  requirePolicyRecommendation(recommendationId: string): PolicyRecommendation;
}

export interface ProposalStoreAttentionMethods {
  recordAttentionEvent(input: RecordAttentionEventInput): AttentionEvent;
  listAttentionEvents(filters?: {
      event_type?: AttentionEventType;
      severity?: AttentionSeverity;
      proposal_id?: string;
      capability?: string;
      tenant?: string;
      principal?: string;
      from?: string;
      limit?: number;
    }): AttentionEvent[];
  getAttentionEvent(eventId: string): AttentionEvent | undefined;
  listAttentionItems(filters?: {
      status?: AttentionItemStatus;
      severity?: AttentionSeverity;
      capability?: string;
      tenant?: string;
      principal?: string;
      limit?: number;
    }): AttentionItem[];
  getAttentionItem(attentionId: string): AttentionItem | undefined;
  acknowledgeAttention(input: {
      attention_id: string;
      actor: string;
      identity?: OperatorIdentityProof;
      require_verified_identity?: boolean;
      now?: string;
    }): AttentionItem;
  resolveAttention(input: {
      attention_id: string;
      now?: string;
    }): AttentionItem;
  enqueueNotificationDelivery(input: {
      sink_id: string;
      event_id: string;
      attention_id?: string;
      max_attempts?: number;
      status?: "pending" | "batched" | "suppressed";
      next_attempt_at?: string;
      now?: string;
    }): NotificationDelivery;
  includeNotificationDeliveriesInDigest(input: {
      sink_id: string;
      delivery_ids: string[];
      digest_event_id: string;
      now?: string;
    }): number;
  claimNotificationDeliveries(input: {
      owner: string;
      sink_id?: string;
      limit?: number;
      lease_seconds?: number;
      now?: string;
    }): NotificationDelivery[];
  completeNotificationDelivery(input: {
      delivery_id: string;
      owner: string;
      lease_id: string;
      external_reference?: string;
      now?: string;
    }): NotificationDelivery;
  failNotificationDelivery(input: {
      delivery_id: string;
      owner: string;
      lease_id: string;
      error_code: string;
      retryable: boolean;
      retry_at?: string;
      now?: string;
    }): NotificationDelivery;
  listNotificationDeliveries(filters?: {
      status?: NotificationDeliveryStatus;
      sink_id?: string;
      event_id?: string;
      attention_id?: string;
      limit?: number;
    }): NotificationDelivery[];
  getNotificationDelivery(deliveryId: string): NotificationDelivery | undefined;
  requeueNotificationDelivery(input: {
      delivery_id: string;
      identity: OperatorIdentityProof;
      reason: string;
      now?: string;
    }): NotificationDelivery;
}

export interface ProposalStoreAttentionInternalMethods {
  recordAttentionEventInternal(input: RecordAttentionEventInput): AttentionEvent;
  closeProposalExpiryAttention(
      event: AttentionEvent,
      status: "resolved" | "expired",
    ): void;
  projectAttentionItem(event: AttentionEvent): void;
  requireAttentionItem(attentionId: string): AttentionItem;
  requireAttentionEvent(eventId: string): AttentionEvent;
  requireNotificationDelivery(deliveryId: string): NotificationDelivery;
  assertNotificationLease(
      deliveryId: string,
      owner: string,
      leaseId: string,
      now: string,
    ): NotificationDelivery;
}

export interface ProposalStoreCloudControlMethods {
  enqueueCloudOutbox(input: {
      event_id: string;
      proposal_id?: string;
      sequence?: number;
      kind: CloudOutboxKind;
      payload: Record<string, unknown>;
      max_attempts?: number;
      now?: string;
    }): CloudOutboxItem;
  claimCloudOutbox(input: { owner: string; limit?: number; lease_ms?: number; now?: string }): CloudOutboxItem[];
  acknowledgeCloudOutbox(eventId: string, owner: string, now?: string): CloudOutboxItem;
  failCloudOutbox(input: { event_id: string; owner: string; error_code: string; retryable: boolean; retry_after_ms?: number; reconciliation?: boolean; now?: string }): CloudOutboxItem;
  requeueCloudOutbox(eventId: string, now?: string): CloudOutboxItem;
  listCloudOutbox(filters?: { status?: CloudOutboxStatus; proposal_id?: string; limit?: number }): CloudOutboxItem[];
  compactCloudOutbox(input: { acknowledged_before: string }): number;
  recordCloudGovernanceEvent(input: Omit<CloudGovernanceEvent, "authority" | "integrity_hash" | "created_at"> & { created_at?: string }): CloudGovernanceEvent;
  listCloudGovernanceEvents(proposalId?: string): CloudGovernanceEvent[];
  workerControlState(): WorkerControlState;
  updateWorkerControl(input: WorkerControlTarget & {
      actor: string;
      identity?: OperatorIdentityProof;
      require_verified_identity?: boolean;
      environment?: string;
      now?: string;
    }): WorkerControlState;
  setRunnerState(key: string, value: Record<string, unknown>): void;
  getRunnerState(key: string): Record<string, unknown> | undefined;
  sharedLedgerEntries(): SharedLedgerEntry[];
  importSharedLedgerEntries(entries: SharedLedgerEntry[]): SharedLedgerImportResult;
}

export interface ProposalStoreCloudControlInternalMethods {
  requireCloudOutboxItem(eventId: string): CloudOutboxItem;
  restoreSharedLedgerEntry(table: string, payload: Record<string, unknown>): boolean;
}

export interface ProposalStoreShadowMethods {
  createShadowStudy(input: {
      study_id?: string;
      name: string;
      description?: string;
      selected_capabilities?: string[];
      starts_at?: string;
      ends_at?: string;
    }): StoredShadowStudy;
  getShadowStudy(studyId: string): StoredShadowStudy | undefined;
  listShadowStudies(): StoredShadowStudy[];
  closeShadowStudy(studyId: string, endsAt?: string): StoredShadowStudy;
  syncShadowStudy(studyId: string): { attached: number; total: number };
  addShadowProposalToStudy(studyId: string, proposalId: string, requestId?: string): StoredShadowCase;
  recordShadowCase(input: {
      study_id: string;
      request_id: string;
      proposal_id?: string;
      tenant_id: string;
      principal?: string;
      capability: string;
      business_object: string;
      object_id: string;
      evidence_bundle_id?: string;
      proposed_effect?: ShadowEffect;
      agent_result: ShadowAgentResult;
      decision_reason?: string;
      risk_score?: number;
      amount_value?: number;
      created_at?: string;
    }): StoredShadowCase;
  getShadowCase(caseId: string): StoredShadowCase | undefined;
  shadowCases(studyId: string): StoredShadowCase[];
  recordShadowOutcome(input: {
      study_id: string;
      request_id: string;
      proposal_id?: string;
      tenant_id: string;
      business_object: string;
      object_id: string;
      actor: string;
      disposition: ShadowOutcomeDisposition;
      actual_effect?: ShadowEffect;
      occurred_at?: string;
      source: string;
      reference?: string;
      reason?: string;
    }): StoredShadowOutcome;
  getShadowOutcome(outcomeId: string): StoredShadowOutcome | undefined;
  shadowOutcomes(studyId: string): StoredShadowOutcome[];
  compareShadowStudyCase(caseId: string): ShadowStudyComparison;
  shadowStudyReport(studyId: string): ShadowStudyReport;
  recordShadowHumanAction(
      proposalId: string,
      input: { actor: string; patch: Record<string, unknown>; notes?: string },
    ): StoredShadowHumanAction;
  shadowHumanActions(proposalId: string): StoredShadowHumanAction[];
  compareShadowProposal(proposalId: string): ShadowComparison;
  shadowReport(): ShadowReport;
}

export interface ProposalStoreShadowInternalMethods {
  requireShadowStudy(studyId: string): StoredShadowStudy;
  latestShadowOutcomeForCase(shadowCase: StoredShadowCase): StoredShadowOutcome | undefined;
  attachShadowChangeSetToActiveStudies(changeSet: ChangeSet, createdAt: string): void;
  insertShadowCaseFromChangeSet(studyId: string, changeSet: ChangeSet, createdAt: string): void;
}

export interface ProposalStoreCoreInternalMethods {
  requireProposal(proposalId: string): StoredProposal;
  assertApprovalFreshness(
      proposal: StoredProposal,
      proofDigest: string | undefined,
      now: string,
    ): void;
  setState(
      proposalId: string,
      state: LocalProposalState,
      actor: string,
      payload: Record<string, unknown>,
    ): void;
  appendEvent(
      proposalId: string,
      kind: string,
      actor: string,
      payload: Record<string, unknown>,
    ): void;
  attentionEnvironment(): string;
  resolveSatisfiedProposalReviewAttention(
      proposal: StoredProposal,
      now: string,
    ): void;
  queryAudit(proposalId: string): Record<string, unknown>[];
  queryAuditByEvidence(evidenceBundleId: string): Record<string, unknown>[];
  evidence(proposalId: string): Record<string, unknown>[];
  evidenceItems(evidenceBundleId: string): Record<string, unknown>[];
  evidenceMetadata(input: {
      proposal?: StoredProposal;
      payload: Record<string, unknown>;
      items: Record<string, unknown>[];
    }): {
      principal?: string;
      capability?: string;
      source_id?: string;
      source_table?: string;
      business_object?: string;
      object_id?: string;
      query_fingerprint?: string;
    };
  queryAuditMetadata(input: {
      proposal?: StoredProposal;
      evidence?: StoredEvidenceBundle;
      payload: Record<string, unknown>;
    }): {
      tenant_id?: string;
      principal?: string;
      capability?: string;
      business_object?: string;
      object_id?: string;
      primary_key_value?: string;
    };
  countTable(table: string): number;
  countWhere(table: string, where: string, params: SQLInputValue[]): number;
  numberValue(sql: string): number;
  stringColumn(sql: string, params: SQLInputValue[], column: string): string[];
  evidenceIdsForPrune(cutoffIso: string, proposalIds: string[]): string[];
  transaction<T>(fn: () => T): T;
}

export interface ProposalStorePublicMethods extends ProposalStoreSchemaMethods, ProposalStoreProposalMethods, ProposalStoreWritebackMethods, ProposalStoreWorkerMethods, ProposalStoreMetricsPolicyMethods, ProposalStoreAttentionMethods, ProposalStoreCloudControlMethods, ProposalStoreShadowMethods {}

export interface ProposalStoreInternalMethods extends ProposalStoreSchemaInternalMethods, ProposalStoreWritebackInternalMethods, ProposalStoreWorkerInternalMethods, ProposalStoreMetricsPolicyInternalMethods, ProposalStoreAttentionInternalMethods, ProposalStoreCloudControlInternalMethods, ProposalStoreShadowInternalMethods, ProposalStoreCoreInternalMethods {}

export interface ProposalStoreMethodContext
  extends ProposalStorePublicMethods, ProposalStoreInternalMethods {
  readonly db: DatabaseSync;
  readonly path: string;
}
