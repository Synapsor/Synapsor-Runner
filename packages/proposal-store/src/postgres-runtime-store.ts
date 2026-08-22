import { resolve } from "node:path";
import {
  parseWritebackJob,
  parseWritebackResult,
  type FreshnessProofV1,
  type WritebackResult,
} from "@synapsor-runner/protocol";
import type {
  LocalProposalState,
  StoredProposal,
  ProposalEvent,
  OperatorIdentityProof,
  StoredApproval,
  ApprovalProgress,
  StoredWritebackReceipt,
  WritebackIntentStatus,
  StoredWritebackIntent,
  WritebackIntentClaim,
  ProposalReplayRecord,
  StoredEvidenceBundle,
  CloudOutboxItem,
  CloudGovernanceEvent,
  AttentionEvent,
  AttentionItem,
  NotificationDelivery,
  ProposalSearchFilters,
  EvidenceSearchFilters,
  QueryAuditSearchFilters,
  OperationalMetricRow,
  PolicyRecommendationStatus,
  PolicyRecommendation,
  CreatePolicyRecommendationInput,
  FleetEventMetricRow,
  WorkerQueueStatus,
  WorkerControlState,
  WorkerQueueItem,
  SharedLedgerEntry,
  ActiveProposalLookup,
  PolicyApprovalDecision,
  ProposalRuntimeStore,
  PostgresRuntimeClient,
  PostgresRuntimePool,
  PostgresProposalRuntimeStoreOptions,
  PostgresWritebackIntentStoreOptions,
  ExploreBudgetLimits,
  ExploreBudgetUsage,
  ProductionExploreBudgetReservationDecision,
  ProductionExploreBudgetReservationInput,
  ProductionExplorePrivacyReleaseDecision,
  ProductionExplorePrivacyReleaseInput,
  CompleteExploreBudgetReservationDecision,
  CompleteExploreBudgetReservationInput,
  ProductionExploreAuditEventInput,
} from "./domain-types.js";
import { isRecord } from "./common.js";
import { assertNoSecretMaterial } from "./proposal-integrity.js";
import {
  writebackIntentPayload,
  writebackIntentFromPayload,
  assertIntentMatchesJob,
  intentJobId,
} from "./record-codecs.js";
import { ProposalStoreError } from "./errors.js";
import { ProposalStore } from "./sqlite-store.js";
import { normalizedExplorePrivacyReleaseClaims } from "./privacy-release.js";

/**
 * Durable intent authority for fleet applies. It writes the intent ledger entry
 * before touching the source database and does not depend on the CLI's final
 * runtime-store bridge sync.
 */
export class PostgresWritebackIntentStore {
  private readonly pool: PostgresRuntimePool;
  private readonly schema: string;
  private readonly autoMigrate: boolean;
  private readonly closePool: boolean;
  private migrationPromise?: Promise<void>;

  constructor(options: PostgresWritebackIntentStoreOptions) {
    this.pool = options.pool;
    this.schema = options.schema ?? "synapsor_runner";
    assertSafePostgresIdentifier(this.schema, "schema");
    this.autoMigrate = options.autoMigrate === true;
    this.closePool = options.closePool === true;
  }

  async close(): Promise<void> {
    if (this.closePool) await this.pool.end?.();
  }

  async claimWritebackIntent(jobInput: unknown, runnerId: string): Promise<WritebackIntentClaim> {
    const job = parseWritebackJob(jobInput);
    return await this.withIntent(job.job_id, async (client, existing) => {
      const intentId = `wbi:${job.job_id}`;
      if (existing) {
        assertIntentMatchesJob(existing, job);
        if (["applied", "already_applied", "conflict", "failed"].includes(existing.status)) {
          if (!existing.result) return { decision: "reconciliation_required", intent_id: intentId, reason: "terminal intent is missing its durable result" };
          return { decision: "existing_result", intent_id: intentId, result: existing.result };
        }
        if (existing.status === "applying" || existing.status === "reconciliation_required") {
          return { decision: "reconciliation_required", intent_id: intentId, reason: existing.reconciliation_reason ?? "a previous apply crossed the source mutation boundary without a durable terminal result" };
        }
        return { decision: "proceed", intent_id: intentId };
      }
      const now = new Date().toISOString();
      await this.writeIntent(client, {
        intent_id: intentId,
        idempotency_key: job.idempotency_key,
        writeback_job_id: job.job_id,
        proposal_id: job.proposal_id,
        proposal_hash: job.approval_id,
        runner_id: runnerId,
        operation: job.operation ?? "single_row_update",
        status: "intent_recorded",
        intent: job,
        created_at: now,
        updated_at: now,
      });
      return { decision: "proceed", intent_id: intentId };
    });
  }

  async markWritebackIntentApplying(intentId: string, runnerId: string): Promise<void> {
    await this.withIntent(intentJobId(intentId), async (client, existing) => {
      if (!existing) throw new ProposalStoreError("WRITEBACK_INTENT_NOT_FOUND", `writeback intent not found: ${intentId}`);
      if (existing.status !== "intent_recorded") throw new ProposalStoreError("WRITEBACK_INTENT_NOT_CLAIMABLE", `writeback intent ${intentId} is ${existing.status}`);
      await this.writeIntent(client, { ...existing, runner_id: runnerId, status: "applying", reconciliation_reason: undefined, updated_at: new Date().toISOString() });
    });
  }

  async completeWritebackIntent(intentId: string, resultInput: WritebackResult): Promise<void> {
    const result = parseWritebackResult(resultInput);
    await this.withIntent(intentJobId(intentId), async (client, existing) => {
      if (!existing) throw new ProposalStoreError("WRITEBACK_INTENT_NOT_FOUND", `writeback intent not found: ${intentId}`);
      if (existing.writeback_job_id !== result.job_id) throw new ProposalStoreError("WRITEBACK_INTENT_RESULT_MISMATCH", `result ${result.job_id} does not belong to ${intentId}`);
      if (existing.result && JSON.stringify(existing.result) === JSON.stringify(result)) return;
      if (existing.status !== "applying" && existing.status !== "reconciliation_required") throw new ProposalStoreError("WRITEBACK_INTENT_COMPLETION_CONFLICT", `writeback intent ${intentId} is ${existing.status}`);
      await this.writeIntent(client, {
        ...existing,
        status: result.status as WritebackIntentStatus,
        result,
        reconciliation_reason: result.status === "reconciliation_required" ? "source outcome requires operator reconciliation" : undefined,
        updated_at: new Date().toISOString(),
      });
    });
  }

  async requireWritebackReconciliation(intentId: string, reason: string): Promise<void> {
    await this.withIntent(intentJobId(intentId), async (client, existing) => {
      if (!existing) throw new ProposalStoreError("WRITEBACK_INTENT_NOT_FOUND", `writeback intent not found: ${intentId}`);
      if (existing.status === "applied" || existing.status === "already_applied") return;
      await this.writeIntent(client, { ...existing, status: "reconciliation_required", reconciliation_reason: String(reason).slice(0, 500), updated_at: new Date().toISOString() });
    });
  }

  private async withIntent<T>(jobId: string, callback: (client: PostgresRuntimeClient, intent: StoredWritebackIntent | undefined) => Promise<T>): Promise<T> {
    await this.ensureMigrated();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`synapsor-writeback-intent:${this.schema}:${jobId}`]);
      const qualified = `${quotePostgresIdentifier(this.schema)}.ledger_entries`;
      const selected = await client.query(`SELECT payload_json FROM ${qualified} WHERE entry_key = $1 FOR UPDATE`, [`writeback_intents:wbi:${jobId}`]);
      const intent = selected.rows[0] ? writebackIntentFromPayload(parseJsonRecord(selected.rows[0].payload_json)) : undefined;
      const result = await callback(client, intent);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureMigrated(): Promise<void> {
    if (!this.autoMigrate) return;
    if (!this.migrationPromise) {
      const attempt = this.migrateUnderLock();
      this.migrationPromise = attempt.catch((error) => {
        this.migrationPromise = undefined;
        throw error;
      });
    }
    await this.migrationPromise;
  }

  private async migrateUnderLock(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`synapsor-writeback-intent:${this.schema}:migration`]);
      await client.query(sharedPostgresRuntimeStoreMigration(this.schema));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async writeIntent(client: PostgresRuntimeClient, intent: StoredWritebackIntent): Promise<void> {
    const payload = writebackIntentPayload(intent);
    assertNoSecretMaterial(payload, "shared_ledger.writeback_intent");
    const qualified = `${quotePostgresIdentifier(this.schema)}.ledger_entries`;
    await client.query(
      `INSERT INTO ${qualified} (entry_key, kind, proposal_id, payload_json, created_at)
VALUES ($1, 'writeback_intent', $2, $3::jsonb, $4::timestamptz)
ON CONFLICT (entry_key) DO UPDATE SET kind = EXCLUDED.kind, proposal_id = EXCLUDED.proposal_id, payload_json = EXCLUDED.payload_json, created_at = EXCLUDED.created_at`,
      [`writeback_intents:${intent.intent_id}`, intent.proposal_id, JSON.stringify(payload), intent.created_at],
    );
  }
}

export class PostgresProposalRuntimeStore implements ProposalRuntimeStore {
  private readonly pool: PostgresRuntimePool;
  private readonly schema: string;
  private readonly lockTimeoutMs: number;
  private readonly autoMigrate: boolean;
  private readonly closePool: boolean;
  private readonly maxEntries: number;
  private migrationPromise?: Promise<void>;
  private productionExploreMaintenancePromise?: Promise<void>;
  private lastProductionExploreMaintenanceAt = 0;

  constructor(options: PostgresProposalRuntimeStoreOptions) {
    this.pool = options.pool;
    this.schema = options.schema ?? "synapsor_runner";
    assertSafePostgresIdentifier(this.schema, "schema");
    this.lockTimeoutMs = Math.max(0, options.lockTimeoutMs ?? 10_000);
    this.autoMigrate = options.autoMigrate === true;
    this.closePool = options.closePool === true;
    this.maxEntries = Math.max(100, Math.min(options.maxEntries ?? 10_000, 100_000));
  }

  async close(): Promise<void> {
    if (this.closePool) await this.pool.end?.();
  }

  async recordEvidenceBundle(input: Parameters<ProposalRuntimeStore["recordEvidenceBundle"]>[0]): Promise<void> {
    await this.withWrite("recordEvidenceBundle", (store) => store.recordEvidenceBundle(input));
  }

  async recordQueryAudit(input: Parameters<ProposalRuntimeStore["recordQueryAudit"]>[0]): Promise<void> {
    await this.withWrite("recordQueryAudit", (store) => store.recordQueryAudit(input));
  }

  async recordProductionExploreAuditEvent(input: ProductionExploreAuditEventInput): Promise<void> {
    if (!input.event_id || !Number.isFinite(Date.parse(input.created_at))) {
      throw new ProposalStoreError(
        "PRODUCTION_EXPLORE_AUDIT_INVALID",
        "Production Explore audit metadata is invalid.",
      );
    }
    assertNoSecretMaterial(input.payload, "production_explore.audit_event");
    await this.ensureProductionExploreMigrated();
    const table = `${quotePostgresIdentifier(this.schema)}.production_explore_audit_events`;
    await this.pool.query(
      `INSERT INTO ${table} (event_id, event_kind, payload_json, created_at)
VALUES ($1, $2, $3::jsonb, $4::timestamptz)`,
      [input.event_id, input.event_kind, JSON.stringify(input.payload), input.created_at],
    );
    this.scheduleProductionExploreMaintenance(Date.parse(input.created_at));
  }

  async findActiveProposal(input: ActiveProposalLookup): Promise<StoredProposal | undefined> {
    return await this.withRead((store) => store.findActiveProposal(input));
  }

  async createProposal(input: unknown): Promise<StoredProposal> {
    return await this.withWrite("createProposal", (store) => store.createProposal(input));
  }

  async recordFreshnessProof(input: unknown): Promise<FreshnessProofV1> {
    return await this.withWrite("recordFreshnessProof", (store) => store.recordFreshnessProof(input));
  }

  async latestFreshnessProof(proposalId: string): Promise<FreshnessProofV1 | undefined> {
    return await this.withRead((store) => store.latestFreshnessProof(proposalId));
  }

  async recordFreshnessApprovalBlocked(
    proposalId: string,
    input: Parameters<ProposalRuntimeStore["recordFreshnessApprovalBlocked"]>[1],
  ): Promise<void> {
    await this.withWrite("recordFreshnessApprovalBlocked", (store) => store.recordFreshnessApprovalBlocked(proposalId, input));
  }

  async approveProposalByPolicy(
    proposalId: string,
    options: Parameters<ProposalRuntimeStore["approveProposalByPolicy"]>[1],
  ): Promise<PolicyApprovalDecision> {
    return await this.withWrite("approveProposalByPolicy", (store) => store.approveProposalByPolicy(proposalId, options));
  }

  async getProposal(proposalId: string): Promise<StoredProposal | undefined> {
    return await this.withRead((store) => store.getProposal(proposalId));
  }

  async listProposals(filters?: LocalProposalState | ProposalSearchFilters): Promise<StoredProposal[]> {
    return await this.withRead((store) => store.listProposals(filters));
  }

  async approvals(proposalId: string): Promise<StoredApproval[]> {
    return await this.withRead((store) => store.approvals(proposalId));
  }

  async approvalProgress(proposalId: string): Promise<ApprovalProgress> {
    return await this.withRead((store) => store.approvalProgress(proposalId));
  }

  async operationalMetrics(filters: { tenant?: string; capability?: string } = {}): Promise<OperationalMetricRow[]> {
    return await this.withRead((store) => store.operationalMetrics(filters));
  }

  async fleetEventMetrics(filters: { tenant?: string; capability?: string } = {}): Promise<FleetEventMetricRow[]> {
    return await this.withRead((store) => store.fleetEventMetrics(filters));
  }

  async createPolicyRecommendation(input: CreatePolicyRecommendationInput): Promise<PolicyRecommendation> {
    return await this.withWrite("createPolicyRecommendation", (store) => store.createPolicyRecommendation(input));
  }

  async getPolicyRecommendation(recommendationId: string): Promise<PolicyRecommendation | undefined> {
    return await this.withRead((store) => store.getPolicyRecommendation(recommendationId));
  }

  async listPolicyRecommendations(filters: { tenant?: string; capability?: string; policy?: string; status?: PolicyRecommendationStatus } = {}): Promise<PolicyRecommendation[]> {
    return await this.withRead((store) => store.listPolicyRecommendations(filters));
  }

  async decidePolicyRecommendation(recommendationId: string, input: { action: "approve" | "reject"; actor: string; reason: string; identity: OperatorIdentityProof; now?: string }): Promise<PolicyRecommendation> {
    return await this.withWrite("decidePolicyRecommendation", (store) => store.decidePolicyRecommendation(recommendationId, input));
  }

  async markPolicyRecommendationExported(recommendationId: string, input: { actor: string; artifact_digest: string; now?: string }): Promise<PolicyRecommendation> {
    return await this.withWrite("markPolicyRecommendationExported", (store) => store.markPolicyRecommendationExported(recommendationId, input));
  }

  async events(proposalId: string): Promise<ProposalEvent[]> {
    return await this.withRead((store) => store.events(proposalId));
  }

  async receipts(proposalId: string): Promise<StoredWritebackReceipt[]> {
    return await this.withRead((store) => store.receipts(proposalId));
  }

  async getEvidenceBundle(evidenceBundleId: string): Promise<StoredEvidenceBundle | undefined> {
    return await this.withRead((store) => store.getEvidenceBundle(evidenceBundleId));
  }

  async listEvidenceBundles(filters: EvidenceSearchFilters = {}): Promise<StoredEvidenceBundle[]> {
    return await this.withRead((store) => store.listEvidenceBundles(filters));
  }

  async listQueryAudit(filters: QueryAuditSearchFilters = {}): Promise<Record<string, unknown>[]> {
    return await this.withRead((store) => store.listQueryAudit(filters));
  }

  async claimExploreBudgetReservation(
    input: Parameters<NonNullable<ProposalRuntimeStore["claimExploreBudgetReservation"]>>[0],
  ): Promise<ReturnType<ProposalStore["claimExploreBudgetReservation"]>> {
    return await this.withWrite(
      "claimExploreBudgetReservation",
      (store) => store.claimExploreBudgetReservation(input),
    );
  }

  async claimExplorePrivacyRelease(
    input: Parameters<NonNullable<ProposalRuntimeStore["claimExplorePrivacyRelease"]>>[0],
  ): Promise<ReturnType<ProposalStore["claimExplorePrivacyRelease"]>> {
    return await this.withWrite(
      "claimExplorePrivacyRelease",
      (store) => store.claimExplorePrivacyRelease(input),
    );
  }

  async completeExploreBudgetReservation(
    input: Parameters<NonNullable<ProposalRuntimeStore["completeExploreBudgetReservation"]>>[0],
  ): Promise<ReturnType<ProposalStore["completeExploreBudgetReservation"]>> {
    return await this.withWrite(
      "completeExploreBudgetReservation",
      (store) => store.completeExploreBudgetReservation(input),
    );
  }

  async claimProductionExploreBudgetReservation(
    input: ProductionExploreBudgetReservationInput,
  ): Promise<ProductionExploreBudgetReservationDecision> {
    assertProductionExploreBudgetInput(input);
    await this.ensureProductionExploreMigrated();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const scopes = productionExploreScopes(input);
      await lockProductionExploreScopes(client, this.schema, "budget", scopes.map((scope) => scope.fingerprint), this.lockTimeoutMs);
      const table = `${quotePostgresIdentifier(this.schema)}.production_explore_budget_reservations`;
      const now = new Date(input.now);
      const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const minuteStart = new Date(now.getTime() - 60 * 1000).toISOString();
      const snapshots: Array<{
        kind: "principal" | "tenant";
        fingerprint: `sha256:${string}`;
        limits: ExploreBudgetLimits;
        usage: ExploreBudgetUsage;
        variantAlreadyCounted: boolean;
      }> = [];
      for (const scope of scopes) {
        const usageResult = await client.query(`
          SELECT
            COUNT(*)::bigint AS query_count,
            COUNT(*) FILTER (WHERE created_at >= $4::timestamptz)::bigint AS queries_last_minute,
            COALESCE(SUM(CASE WHEN status = 'pending' THEN reserved_cells WHEN status = 'released' THEN accounted_cells ELSE 0 END), 0)::bigint AS extracted_cells
          FROM ${table}
          WHERE scope_kind = $1 AND scope_fingerprint = $2 AND created_at >= $3::timestamptz
        `, [scope.kind, scope.fingerprint, windowStart, minuteStart]);
        const variantResult = await client.query(`
          SELECT DISTINCT variant_fingerprint
          FROM ${table}
          WHERE scope_kind = $1 AND scope_fingerprint = $2
            AND resource_id = $3 AND created_at >= $4::timestamptz
            AND status IN ('pending', 'released') AND differencing_counted = true
        `, [scope.kind, scope.fingerprint, input.resource_id, windowStart]);
        const variants = new Set(variantResult.rows.map((row) => String(row.variant_fingerprint)));
        const usageRow = usageResult.rows[0] ?? {};
        const usage: ExploreBudgetUsage = {
          query_count: Number(usageRow.query_count ?? 0),
          queries_last_minute: Number(usageRow.queries_last_minute ?? 0),
          extracted_cells: Number(usageRow.extracted_cells ?? 0),
          differencing_attempts: variants.size,
        };
        const denied = productionExploreBudgetDenial({
          limits: scope.limits,
          usage,
          variantAlreadyCounted: variants.has(input.variant_fingerprint),
          requiresDifferencing: input.requires_differencing,
          estimatedResponseCells: input.estimated_response_cells,
        });
        if (denied) {
          await client.query("ROLLBACK");
          return {
            ...denied,
            exhausted_scope: scope.kind,
            usage,
          };
        }
        snapshots.push({
          ...scope,
          usage,
          variantAlreadyCounted: variants.has(input.variant_fingerprint),
        });
      }

      for (const snapshot of snapshots) {
        await client.query(`
          INSERT INTO ${table} (
            reservation_id, scope_kind, scope_fingerprint, resource_id,
            variant_fingerprint, requires_differencing, differencing_counted,
            reserved_cells, accounted_cells, status, created_at, completed_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $7, 'pending', $8::timestamptz, NULL)
        `, [
          input.reservation_id,
          snapshot.kind,
          snapshot.fingerprint,
          input.resource_id,
          input.variant_fingerprint,
          input.requires_differencing,
          input.estimated_response_cells,
          input.now,
        ]);
      }
      await client.query("COMMIT");
      this.scheduleProductionExploreMaintenance(now.getTime());
      const principal = snapshots.find((scope) => scope.kind === "principal")!;
      const tenant = snapshots.find((scope) => scope.kind === "tenant")!;
      return {
        allowed: true,
        principal_usage_after_reservation: usageAfterProductionReservation(principal, input),
        tenant_usage_after_reservation: usageAfterProductionReservation(tenant, input),
        principal_variant_already_counted: principal.variantAlreadyCounted,
        tenant_variant_already_counted: tenant.variantAlreadyCounted,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeProductionExploreBudgetReservation(
    input: CompleteExploreBudgetReservationInput,
  ): Promise<CompleteExploreBudgetReservationDecision> {
    if (!Number.isSafeInteger(input.returned_cells) || input.returned_cells < 0 || !Number.isFinite(Date.parse(input.completed_at))) {
      throw new ProposalStoreError("EXPLORE_BUDGET_RESERVATION_INVALID", "Production Explore completion accounting is invalid.");
    }
    await this.ensureProductionExploreMigrated();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const table = `${quotePostgresIdentifier(this.schema)}.production_explore_budget_reservations`;
      const initial = await client.query(`SELECT scope_fingerprint FROM ${table} WHERE reservation_id = $1`, [input.reservation_id]);
      if (initial.rows.length !== 2) {
        await client.query("ROLLBACK");
        return { completed: false, reason: "reservation_missing" };
      }
      await lockProductionExploreScopes(
        client,
        this.schema,
        "budget",
        initial.rows.map((row) => String(row.scope_fingerprint)),
        this.lockTimeoutMs,
      );
      const selected = await client.query(`
        SELECT scope_kind, status, requires_differencing, reserved_cells, accounted_cells
        FROM ${table} WHERE reservation_id = $1 FOR UPDATE
      `, [input.reservation_id]);
      if (selected.rows.length !== 2) {
        await client.query("ROLLBACK");
        return { completed: false, reason: "reservation_missing" };
      }
      if (selected.rows.every((row) => String(row.status) !== "pending")) {
        const same = selected.rows.every((row) =>
          (String(row.status) === "released") === input.result_released
          && Number(row.accounted_cells) === (input.result_released ? input.returned_cells : 0));
        await client.query("COMMIT");
        return same
          ? { completed: true }
          : { completed: false, reason: "reservation_already_finalized" };
      }
      if (selected.rows.some((row) => String(row.status) !== "pending")) {
        await client.query("ROLLBACK");
        return { completed: false, reason: "reservation_already_finalized" };
      }
      if (input.result_released && selected.rows.some((row) => input.returned_cells > Number(row.reserved_cells))) {
        await client.query(`
          UPDATE ${table}
          SET status = 'not_released', differencing_counted = false,
              accounted_cells = 0, completed_at = $2::timestamptz
          WHERE reservation_id = $1 AND status = 'pending'
        `, [input.reservation_id, input.completed_at]);
        await client.query("COMMIT");
        return { completed: false, reason: "response_exceeded_reservation" };
      }
      await client.query(`
        UPDATE ${table}
        SET status = $2,
            differencing_counted = CASE WHEN $3::boolean THEN requires_differencing ELSE false END,
            accounted_cells = $4,
            completed_at = $5::timestamptz
        WHERE reservation_id = $1 AND status = 'pending'
      `, [
        input.reservation_id,
        input.result_released ? "released" : "not_released",
        input.result_released,
        input.result_released ? input.returned_cells : 0,
        input.completed_at,
      ]);
      await client.query("COMMIT");
      return { completed: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimProductionExplorePrivacyRelease(
    input: ProductionExplorePrivacyReleaseInput,
  ): Promise<ProductionExplorePrivacyReleaseDecision> {
    assertProductionExplorePrivacyReleaseInput(input);
    const claims = normalizedExplorePrivacyReleaseClaims({
      ...input,
      scope_fingerprint: input.principal_scope_fingerprint,
    });
    if (claims.length === 0) return { allowed: true };
    await this.ensureProductionExploreMigrated();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const scopes = [
        { kind: "principal" as const, fingerprint: input.principal_scope_fingerprint },
        { kind: "tenant" as const, fingerprint: input.tenant_scope_fingerprint },
      ];
      await lockProductionExploreScopes(client, this.schema, "privacy", scopes.map((scope) => scope.fingerprint), this.lockTimeoutMs);
      const table = `${quotePostgresIdentifier(this.schema)}.production_explore_privacy_releases`;
      for (const scope of scopes) {
        for (const claim of claims) {
          const opposite = claim.release_kind === "scalar_total" ? "suppressed_grouping" : "scalar_total";
          const conflict = await client.query(`
            SELECT release_kind FROM ${table}
            WHERE scope_kind = $1 AND scope_fingerprint = $2
              AND release_kind = $3 AND complement_fingerprint = ANY($4::text[])
              AND created_at >= now() - interval '24 hours'
            LIMIT 1
          `, [scope.kind, scope.fingerprint, opposite, claim.complement_fingerprints]);
          if (conflict.rows.length > 0) {
            await client.query("ROLLBACK");
            return {
              allowed: false,
              conflicting_release_kind: opposite,
              ...(claim.conflict_reason
                ? { conflicting_release_reason: claim.conflict_reason }
                : {}),
              conflicting_scope: scope.kind,
            };
          }
        }
      }
      for (const scope of scopes) {
        for (const claim of claims) {
          for (const fingerprint of claim.complement_fingerprints) {
            await client.query(`
              INSERT INTO ${table} (
                scope_kind, scope_fingerprint, complement_fingerprint,
                release_kind, query_fingerprint, boundary_digest
              ) VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (scope_kind, scope_fingerprint, complement_fingerprint, release_kind)
              DO UPDATE SET query_fingerprint = EXCLUDED.query_fingerprint,
                            boundary_digest = EXCLUDED.boundary_digest,
                            created_at = now()
            `, [scope.kind, scope.fingerprint, fingerprint, claim.release_kind, input.query_fingerprint, input.boundary_digest]);
          }
        }
      }
      await client.query("COMMIT");
      this.scheduleProductionExploreMaintenance(Date.now());
      return { allowed: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async replay(proposalId: string): Promise<ProposalReplayRecord> {
    return await this.withWrite("replay", (store) => store.replay(proposalId));
  }

  async claimWritebackIntent(job: unknown, runnerId: string): Promise<WritebackIntentClaim> {
    return await this.withWrite("claimWritebackIntent", (store) => store.claimWritebackIntent(job, runnerId));
  }

  async markWritebackIntentApplying(intentId: string, runnerId: string): Promise<void> {
    await this.withWrite("markWritebackIntentApplying", (store) => store.markWritebackIntentApplying(intentId, runnerId));
  }

  async completeWritebackIntent(intentId: string, result: WritebackResult): Promise<void> {
    await this.withWrite("completeWritebackIntent", (store) => store.completeWritebackIntent(intentId, result));
  }

  async requireWritebackReconciliation(intentId: string, reason: string): Promise<void> {
    await this.withWrite("requireWritebackReconciliation", (store) => store.requireWritebackReconciliation(intentId, reason));
  }

  async enqueueWorkerProposal(input: Parameters<NonNullable<ProposalRuntimeStore["enqueueWorkerProposal"]>>[0]): Promise<WorkerQueueItem> {
    return await this.withWrite("enqueueWorkerProposal", (store) => store.enqueueWorkerProposal(input));
  }

  async claimWorkerItem(input: Parameters<NonNullable<ProposalRuntimeStore["claimWorkerItem"]>>[0]): Promise<WorkerQueueItem | undefined> {
    return await this.withWrite("claimWorkerItem", (store) => store.claimWorkerItem(input));
  }

  async assertActiveWorkerLease(input: Parameters<NonNullable<ProposalRuntimeStore["assertActiveWorkerLease"]>>[0]): Promise<WorkerQueueItem> {
    return await this.withRead((store) => store.assertActiveWorkerLease(input));
  }

  async renewWorkerLease(input: Parameters<NonNullable<ProposalRuntimeStore["renewWorkerLease"]>>[0]): Promise<WorkerQueueItem> {
    return await this.withWrite("renewWorkerLease", (store) => store.renewWorkerLease(input));
  }

  async completeWorkerItem(
    proposalId: string,
    workerId: string,
    outcome: "applied" | "already_applied" | "conflict",
    now?: string,
    leaseId?: string,
  ): Promise<WorkerQueueItem> {
    return await this.withWrite("completeWorkerItem", (store) =>
      store.completeWorkerItem(proposalId, workerId, outcome, now, leaseId));
  }

  async blockWorkerItem(input: Parameters<NonNullable<ProposalRuntimeStore["blockWorkerItem"]>>[0]): Promise<WorkerQueueItem> {
    return await this.withWrite("blockWorkerItem", (store) => store.blockWorkerItem(input));
  }

  async requireWorkerReconciliation(
    input: Parameters<NonNullable<ProposalRuntimeStore["requireWorkerReconciliation"]>>[0],
  ): Promise<WorkerQueueItem> {
    return await this.withWrite("requireWorkerReconciliation", (store) => store.requireWorkerReconciliation(input));
  }

  async workerControlState(): Promise<WorkerControlState> {
    return await this.withRead((store) => store.workerControlState());
  }

  async updateWorkerControl(
    input: Parameters<NonNullable<ProposalRuntimeStore["updateWorkerControl"]>>[0],
  ): Promise<WorkerControlState> {
    return await this.withWrite("updateWorkerControl", (store) => store.updateWorkerControl(input));
  }

  async cancelWorkerItem(
    input: Parameters<NonNullable<ProposalRuntimeStore["cancelWorkerItem"]>>[0],
  ): Promise<WorkerQueueItem> {
    return await this.withWrite("cancelWorkerItem", (store) => store.cancelWorkerItem(input));
  }

  async listWorkerQueue(status?: WorkerQueueStatus): Promise<WorkerQueueItem[]> {
    return await this.withRead((store) => store.listWorkerQueue(status));
  }

  async getWorkerQueueItem(proposalId: string): Promise<WorkerQueueItem | undefined> {
    return await this.withRead((store) => store.getWorkerQueueItem(proposalId));
  }

  async recordAttentionEvent(input: Parameters<NonNullable<ProposalRuntimeStore["recordAttentionEvent"]>>[0]): Promise<AttentionEvent> {
    return await this.withWrite("recordAttentionEvent", (store) => store.recordAttentionEvent(input));
  }

  async listAttentionEvents(
    filters: Parameters<NonNullable<ProposalRuntimeStore["listAttentionEvents"]>>[0] = {},
  ): Promise<AttentionEvent[]> {
    return await this.withRead((store) => store.listAttentionEvents(filters));
  }

  async getAttentionEvent(eventId: string): Promise<AttentionEvent | undefined> {
    return await this.withRead((store) => store.getAttentionEvent(eventId));
  }

  async listAttentionItems(
    filters: Parameters<NonNullable<ProposalRuntimeStore["listAttentionItems"]>>[0] = {},
  ): Promise<AttentionItem[]> {
    return await this.withRead((store) => store.listAttentionItems(filters));
  }

  async getAttentionItem(attentionId: string): Promise<AttentionItem | undefined> {
    return await this.withRead((store) => store.getAttentionItem(attentionId));
  }

  async acknowledgeAttention(input: Parameters<NonNullable<ProposalRuntimeStore["acknowledgeAttention"]>>[0]): Promise<AttentionItem> {
    return await this.withWrite("acknowledgeAttention", (store) => store.acknowledgeAttention(input));
  }

  async resolveAttention(input: Parameters<NonNullable<ProposalRuntimeStore["resolveAttention"]>>[0]): Promise<AttentionItem> {
    return await this.withWrite("resolveAttention", (store) => store.resolveAttention(input));
  }

  async enqueueNotificationDelivery(
    input: Parameters<NonNullable<ProposalRuntimeStore["enqueueNotificationDelivery"]>>[0],
  ): Promise<NotificationDelivery> {
    return await this.withWrite("enqueueNotificationDelivery", (store) => store.enqueueNotificationDelivery(input));
  }

  async includeNotificationDeliveriesInDigest(
    input: Parameters<NonNullable<ProposalRuntimeStore["includeNotificationDeliveriesInDigest"]>>[0],
  ): Promise<number> {
    return await this.withWrite(
      "includeNotificationDeliveriesInDigest",
      (store) => store.includeNotificationDeliveriesInDigest(input),
    );
  }

  async claimNotificationDeliveries(
    input: Parameters<NonNullable<ProposalRuntimeStore["claimNotificationDeliveries"]>>[0],
  ): Promise<NotificationDelivery[]> {
    return await this.withWrite("claimNotificationDeliveries", (store) => store.claimNotificationDeliveries(input));
  }

  async completeNotificationDelivery(
    input: Parameters<NonNullable<ProposalRuntimeStore["completeNotificationDelivery"]>>[0],
  ): Promise<NotificationDelivery> {
    return await this.withWrite("completeNotificationDelivery", (store) => store.completeNotificationDelivery(input));
  }

  async failNotificationDelivery(
    input: Parameters<NonNullable<ProposalRuntimeStore["failNotificationDelivery"]>>[0],
  ): Promise<NotificationDelivery> {
    return await this.withWrite("failNotificationDelivery", (store) => store.failNotificationDelivery(input));
  }

  async listNotificationDeliveries(
    filters: Parameters<NonNullable<ProposalRuntimeStore["listNotificationDeliveries"]>>[0] = {},
  ): Promise<NotificationDelivery[]> {
    return await this.withRead((store) => store.listNotificationDeliveries(filters));
  }

  async getNotificationDelivery(deliveryId: string): Promise<NotificationDelivery | undefined> {
    return await this.withRead((store) => store.getNotificationDelivery(deliveryId));
  }

  async requeueNotificationDelivery(
    input: Parameters<NonNullable<ProposalRuntimeStore["requeueNotificationDelivery"]>>[0],
  ): Promise<NotificationDelivery> {
    return await this.withWrite("requeueNotificationDelivery", (store) => store.requeueNotificationDelivery(input));
  }

  async enqueueCloudOutbox(input: Parameters<NonNullable<ProposalRuntimeStore["enqueueCloudOutbox"]>>[0]): Promise<CloudOutboxItem> {
    return await this.withWrite("enqueueCloudOutbox", (store) => store.enqueueCloudOutbox(input));
  }

  async claimCloudOutbox(input: Parameters<NonNullable<ProposalRuntimeStore["claimCloudOutbox"]>>[0]): Promise<CloudOutboxItem[]> {
    return await this.withWrite("claimCloudOutbox", (store) => store.claimCloudOutbox(input));
  }

  async acknowledgeCloudOutbox(eventId: string, owner: string, now?: string): Promise<CloudOutboxItem> {
    return await this.withWrite("acknowledgeCloudOutbox", (store) => store.acknowledgeCloudOutbox(eventId, owner, now));
  }

  async failCloudOutbox(input: Parameters<NonNullable<ProposalRuntimeStore["failCloudOutbox"]>>[0]): Promise<CloudOutboxItem> {
    return await this.withWrite("failCloudOutbox", (store) => store.failCloudOutbox(input));
  }

  async requeueCloudOutbox(eventId: string, now?: string): Promise<CloudOutboxItem> {
    return await this.withWrite("requeueCloudOutbox", (store) => store.requeueCloudOutbox(eventId, now));
  }

  async listCloudOutbox(filters: Parameters<NonNullable<ProposalRuntimeStore["listCloudOutbox"]>>[0] = {}): Promise<CloudOutboxItem[]> {
    return await this.withRead((store) => store.listCloudOutbox(filters));
  }

  async compactCloudOutbox(input: Parameters<NonNullable<ProposalRuntimeStore["compactCloudOutbox"]>>[0]): Promise<number> {
    return await this.withWrite("compactCloudOutbox", (store) => store.compactCloudOutbox(input));
  }

  async recordCloudGovernanceEvent(input: Parameters<NonNullable<ProposalRuntimeStore["recordCloudGovernanceEvent"]>>[0]): Promise<CloudGovernanceEvent> {
    return await this.withWrite("recordCloudGovernanceEvent", (store) => store.recordCloudGovernanceEvent(input));
  }

  async listCloudGovernanceEvents(proposalId?: string): Promise<CloudGovernanceEvent[]> {
    return await this.withRead((store) => store.listCloudGovernanceEvents(proposalId));
  }

  private async withRead<T>(callback: (store: ProposalStore) => T): Promise<T> {
    const store = await this.transientStoreFromPostgres(this.pool);
    try {
      return callback(store);
    } finally {
      store.close();
    }
  }

  private async ensureProductionExploreMigrated(): Promise<void> {
    if (!this.autoMigrate) return;
    this.migrationPromise ??= migrateSharedPostgresRuntimeStore(
      this.pool,
      this.schema,
      this.lockTimeoutMs,
    ).catch((error) => {
      this.migrationPromise = undefined;
      throw error;
    });
    await this.migrationPromise;
  }

  async runProductionExploreMaintenance(now = new Date()): Promise<void> {
    if (!Number.isFinite(now.getTime())) {
      throw new ProposalStoreError(
        "PRODUCTION_EXPLORE_MAINTENANCE_TIME_INVALID",
        "Production Explore maintenance requires a valid time.",
      );
    }
    await this.ensureProductionExploreMigrated();
    const schema = quotePostgresIdentifier(this.schema);
    const budgetCutoff = new Date(now.getTime() - PRODUCTION_EXPLORE_BUDGET_RETENTION_MS).toISOString();
    const auditCutoff = new Date(now.getTime() - PRODUCTION_EXPLORE_AUDIT_RETENTION_MS).toISOString();
    await this.pool.query(
      `DELETE FROM ${schema}.production_explore_budget_reservations WHERE created_at < $1::timestamptz`,
      [budgetCutoff],
    );
    await this.pool.query(
      `DELETE FROM ${schema}.production_explore_privacy_releases
       WHERE created_at < now() - interval '24 hours'`,
    );
    await this.pool.query(
      `DELETE FROM ${schema}.production_explore_audit_events WHERE created_at < $1::timestamptz`,
      [auditCutoff],
    );
  }

  private scheduleProductionExploreMaintenance(now: number): void {
    if (!Number.isFinite(now)
      || now - this.lastProductionExploreMaintenanceAt < PRODUCTION_EXPLORE_MAINTENANCE_INTERVAL_MS
      || this.productionExploreMaintenancePromise) return;
    this.lastProductionExploreMaintenanceAt = now;
    this.productionExploreMaintenancePromise = this.runProductionExploreMaintenance(new Date(now))
      .catch(() => {
        process.stderr.write(
          "Warning: production Explore control-ledger retention maintenance did not complete; serving continues and the next hourly maintenance window will retry.\n",
        );
      })
      .finally(() => {
        this.productionExploreMaintenancePromise = undefined;
      });
  }

  private async withWrite<T>(operation: string, callback: (store: ProposalStore) => T): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await acquirePostgresRuntimeStoreLock(client, `synapsor-runner:${this.schema}:runtime-store`, this.lockTimeoutMs);
      if (!locked) throw new ProposalStoreError("POSTGRES_RUNTIME_STORE_LOCK_TIMEOUT", `Postgres runtime store lock is held for schema ${this.schema} while running ${operation}`);
      if (this.autoMigrate) await client.query(sharedPostgresRuntimeStoreMigration(this.schema));
      const store = await this.transientStoreFromPostgres(client);
      let result: T;
      try {
        result = callback(store);
        const entries = store.sharedLedgerEntries();
        if (entries.length > this.maxEntries) {
          throw new ProposalStoreError("POSTGRES_RUNTIME_STORE_CAPACITY_EXCEEDED", `Postgres runtime store reached its configured ${this.maxEntries}-entry safety bound`);
        }
        await upsertSharedLedgerEntries(client, this.schema, entries);
      } finally {
        store.close();
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async transientStoreFromPostgres(connection: Pick<PostgresRuntimePool, "query">): Promise<ProposalStore> {
    const entries = await fetchSharedLedgerEntries(connection, this.schema, this.maxEntries);
    const store = new ProposalStore();
    store.importSharedLedgerEntries(entries);
    return store;
  }
}

export async function migrateSharedPostgresRuntimeStore(
  pool: PostgresRuntimePool,
  schema = "synapsor_runner",
  lockTimeoutMs = 10_000,
): Promise<void> {
  assertSafePostgresIdentifier(schema, "schema");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await acquirePostgresRuntimeStoreLock(client, `synapsor-runner:${schema}:runtime-store`, Math.max(0, lockTimeoutMs));
    if (!locked) throw new ProposalStoreError("POSTGRES_RUNTIME_STORE_LOCK_TIMEOUT", `Postgres runtime store migration lock timed out for schema ${schema}`);
    await client.query(sharedPostgresRuntimeStoreMigration(schema));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function sharedPostgresRuntimeStoreMigration(schema = "synapsor_runner"): string {
  assertSafePostgresIdentifier(schema, "schema");
  const s = quotePostgresIdentifier(schema);
  return [
    `CREATE SCHEMA IF NOT EXISTS ${s};`,
    `CREATE TABLE IF NOT EXISTS ${s}.ledger_entries (`,
    "  entry_id bigserial PRIMARY KEY,",
    "  entry_key text UNIQUE NOT NULL,",
    "  kind text NOT NULL,",
    "  proposal_id text,",
    "  tenant_id text,",
    "  capability text,",
    "  payload_json jsonb NOT NULL,",
    "  created_at timestamptz NOT NULL DEFAULT now()",
    ");",
    `CREATE INDEX IF NOT EXISTS idx_synapsor_ledger_entries_proposal ON ${s}.ledger_entries(proposal_id, created_at);`,
    `CREATE INDEX IF NOT EXISTS idx_synapsor_ledger_entries_tenant_capability ON ${s}.ledger_entries(tenant_id, capability, created_at);`,
    `CREATE INDEX IF NOT EXISTS idx_synapsor_ledger_entries_kind_created ON ${s}.ledger_entries(kind, created_at);`,
    `CREATE TABLE IF NOT EXISTS ${s}.proposal_locks (`,
    "  proposal_id text PRIMARY KEY,",
    "  proposal_hash text NOT NULL,",
    "  state text NOT NULL,",
    "  tenant_id text NOT NULL,",
    "  capability text NOT NULL,",
    "  updated_at timestamptz NOT NULL DEFAULT now()",
    ");",
    `CREATE TABLE IF NOT EXISTS ${s}.worker_leases (`,
    "  proposal_id text PRIMARY KEY,",
    "  worker_id text NOT NULL,",
    "  lease_expires_at timestamptz NOT NULL,",
    "  attempt integer NOT NULL DEFAULT 1,",
    "  updated_at timestamptz NOT NULL DEFAULT now()",
    ");",
    `CREATE TABLE IF NOT EXISTS ${s}.rate_limit_buckets (`,
    "  bucket_key text NOT NULL,",
    "  window_start bigint NOT NULL,",
    "  request_count bigint NOT NULL DEFAULT 0,",
    "  rejected_count bigint NOT NULL DEFAULT 0,",
    "  updated_at timestamptz NOT NULL DEFAULT now(),",
    "  PRIMARY KEY (bucket_key, window_start)",
    ");",
    `CREATE TABLE IF NOT EXISTS ${s}.production_explore_budget_reservations (`,
    "  reservation_id text NOT NULL,",
    "  scope_kind text NOT NULL CHECK (scope_kind IN ('principal', 'tenant')),",
    "  scope_fingerprint text NOT NULL,",
    "  resource_id text NOT NULL,",
    "  variant_fingerprint text NOT NULL,",
    "  requires_differencing boolean NOT NULL,",
    "  differencing_counted boolean NOT NULL,",
    "  reserved_cells bigint NOT NULL,",
    "  accounted_cells bigint NOT NULL,",
    "  status text NOT NULL CHECK (status IN ('pending', 'released', 'not_released')),",
    "  created_at timestamptz NOT NULL,",
    "  completed_at timestamptz,",
    "  PRIMARY KEY (reservation_id, scope_kind)",
    ");",
    `CREATE INDEX IF NOT EXISTS idx_synapsor_production_explore_budget_scope_time ON ${s}.production_explore_budget_reservations(scope_kind, scope_fingerprint, created_at);`,
    `CREATE INDEX IF NOT EXISTS idx_synapsor_production_explore_budget_variant ON ${s}.production_explore_budget_reservations(scope_kind, scope_fingerprint, resource_id, variant_fingerprint, created_at);`,
    `CREATE INDEX IF NOT EXISTS idx_synapsor_production_explore_budget_created ON ${s}.production_explore_budget_reservations(created_at);`,
    `CREATE TABLE IF NOT EXISTS ${s}.production_explore_privacy_releases (`,
    "  scope_kind text NOT NULL CHECK (scope_kind IN ('principal', 'tenant')),",
    "  scope_fingerprint text NOT NULL,",
    "  complement_fingerprint text NOT NULL,",
    "  release_kind text NOT NULL CHECK (release_kind IN ('scalar_total', 'suppressed_grouping')),",
    "  query_fingerprint text NOT NULL,",
    "  boundary_digest text NOT NULL,",
    "  created_at timestamptz NOT NULL DEFAULT now(),",
    "  PRIMARY KEY (scope_kind, scope_fingerprint, complement_fingerprint, release_kind)",
    ");",
    `CREATE INDEX IF NOT EXISTS idx_synapsor_production_explore_privacy_scope ON ${s}.production_explore_privacy_releases(scope_kind, scope_fingerprint, complement_fingerprint, release_kind);`,
    `CREATE INDEX IF NOT EXISTS idx_synapsor_production_explore_privacy_created ON ${s}.production_explore_privacy_releases(created_at);`,
    `CREATE TABLE IF NOT EXISTS ${s}.production_explore_audit_events (`,
    "  event_id text PRIMARY KEY,",
    "  event_kind text NOT NULL CHECK (event_kind IN ('query_audit', 'evidence_bundle')),",
    "  payload_json jsonb NOT NULL,",
    "  created_at timestamptz NOT NULL",
    ");",
    `CREATE INDEX IF NOT EXISTS idx_synapsor_production_explore_audit_created ON ${s}.production_explore_audit_events(created_at);`,
  ].join("\n");
}

const PRODUCTION_EXPLORE_BUDGET_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRODUCTION_EXPLORE_AUDIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRODUCTION_EXPLORE_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

type ProductionExploreScopeSnapshot = {
  kind: "principal" | "tenant";
  fingerprint: `sha256:${string}`;
  limits: ExploreBudgetLimits;
  usage: ExploreBudgetUsage;
  variantAlreadyCounted: boolean;
};

function productionExploreScopes(input: ProductionExploreBudgetReservationInput): Array<{
  kind: "principal" | "tenant";
  fingerprint: `sha256:${string}`;
  limits: ExploreBudgetLimits;
}> {
  return [
    { kind: "principal", fingerprint: input.principal_scope_fingerprint, limits: input.principal_limits },
    { kind: "tenant", fingerprint: input.tenant_scope_fingerprint, limits: input.tenant_limits },
  ];
}

function assertProductionExploreBudgetInput(input: ProductionExploreBudgetReservationInput): void {
  if (!/^explore_budget_[a-f0-9]{32}$/.test(input.reservation_id)
    || !/^sha256:[a-f0-9]{64}$/.test(input.principal_scope_fingerprint)
    || !/^sha256:[a-f0-9]{64}$/.test(input.tenant_scope_fingerprint)
    || !/^sha256:[a-f0-9]{64}$/.test(input.variant_fingerprint)
    || !input.resource_id
    || !Number.isSafeInteger(input.estimated_response_cells)
    || input.estimated_response_cells < 0
    || !Number.isFinite(Date.parse(input.now))) {
    throw new ProposalStoreError("EXPLORE_BUDGET_RESERVATION_INVALID", "Production Explore budget reservation input is invalid.");
  }
  for (const limits of [input.principal_limits, input.tenant_limits]) {
    if (!Number.isSafeInteger(limits.max_queries_per_session) || limits.max_queries_per_session < 1
      || !Number.isSafeInteger(limits.rate_limit_per_minute) || limits.rate_limit_per_minute < 1
      || !Number.isSafeInteger(limits.max_extracted_cells_per_session) || limits.max_extracted_cells_per_session < 1
      || !Number.isSafeInteger(limits.max_differencing_queries) || limits.max_differencing_queries < 1
      || !Number.isSafeInteger(limits.max_response_cells) || limits.max_response_cells < 1) {
      throw new ProposalStoreError("EXPLORE_BUDGET_RESERVATION_INVALID", "Production Explore budget limits must be positive safe integers.");
    }
  }
}

function assertProductionExplorePrivacyReleaseInput(input: ProductionExplorePrivacyReleaseInput): void {
  const additionalReleases = input.additional_releases ?? [];
  if (!/^sha256:[a-f0-9]{64}$/.test(input.principal_scope_fingerprint)
    || !/^sha256:[a-f0-9]{64}$/.test(input.tenant_scope_fingerprint)
    || !/^sha256:[a-f0-9]{64}$/.test(input.query_fingerprint)
    || !/^sha256:[a-f0-9]{64}$/.test(input.boundary_digest)
    || input.complement_fingerprints.length > 64
    || input.complement_fingerprints.some((fingerprint) => !/^sha256:[a-f0-9]{64}$/.test(fingerprint))
    || (input.release_kind !== "scalar_total" && input.release_kind !== "suppressed_grouping")
    || additionalReleases.length > 8
    || additionalReleases.some((release) =>
      release.complement_fingerprints.length > 64
      || release.complement_fingerprints.some((fingerprint) => !/^sha256:[a-f0-9]{64}$/.test(fingerprint))
      || (release.release_kind !== "scalar_total" && release.release_kind !== "suppressed_grouping")
      || (release.conflict_reason !== undefined
        && release.conflict_reason !== "scalar_filter_complement"))) {
    throw new ProposalStoreError(
      "EXPLORE_PRIVACY_RELEASE_INVALID",
      "Production Explore privacy release accounting input is invalid.",
    );
  }
}

function productionExploreBudgetDenial(input: {
  limits: ExploreBudgetLimits;
  usage: ExploreBudgetUsage;
  variantAlreadyCounted: boolean;
  requiresDifferencing: boolean;
  estimatedResponseCells: number;
}): Exclude<ProductionExploreBudgetReservationDecision, { allowed: true }> | undefined {
  if (input.usage.query_count >= input.limits.max_queries_per_session) {
    return { allowed: false, code: "QUERY_BUDGET_EXHAUSTED", message: "The rolling 24-hour query budget is exhausted.", exhausted_scope: "principal", usage: input.usage };
  }
  if (input.usage.queries_last_minute >= input.limits.rate_limit_per_minute) {
    return { allowed: false, code: "RATE_LIMIT_EXHAUSTED", message: "The requests-per-minute budget is exhausted.", exhausted_scope: "principal", usage: input.usage };
  }
  if (input.estimatedResponseCells > input.limits.max_response_cells
    || input.usage.extracted_cells + input.estimatedResponseCells > input.limits.max_extracted_cells_per_session) {
    return { allowed: false, code: "EXTRACTION_BUDGET_EXHAUSTED", message: "The rolling 24-hour extracted-cell budget would be exceeded.", exhausted_scope: "principal", usage: input.usage };
  }
  if (input.requiresDifferencing
    && !input.variantAlreadyCounted
    && input.usage.differencing_attempts >= input.limits.max_differencing_queries) {
    return { allowed: false, code: "DIFFERENCING_BUDGET_EXHAUSTED", message: "The rolling 24-hour differencing budget is exhausted.", exhausted_scope: "principal", usage: input.usage };
  }
  return undefined;
}

function usageAfterProductionReservation(
  snapshot: ProductionExploreScopeSnapshot,
  input: ProductionExploreBudgetReservationInput,
): ExploreBudgetUsage {
  return {
    query_count: snapshot.usage.query_count + 1,
    queries_last_minute: snapshot.usage.queries_last_minute + 1,
    extracted_cells: snapshot.usage.extracted_cells + input.estimated_response_cells,
    differencing_attempts: snapshot.usage.differencing_attempts
      + (input.requires_differencing && !snapshot.variantAlreadyCounted ? 1 : 0),
  };
}

async function lockProductionExploreScopes(
  client: PostgresRuntimeClient,
  schema: string,
  purpose: "budget" | "privacy",
  fingerprints: string[],
  timeoutMs: number,
): Promise<void> {
  const keys = [...new Set(fingerprints.map((fingerprint) =>
    `synapsor-runner:${schema}:production-explore:${purpose}:${fingerprint}`))].sort();
  for (const key of keys) {
    const locked = await acquirePostgresRuntimeStoreLock(client, key, timeoutMs);
    if (!locked) {
      throw new ProposalStoreError(
        "POSTGRES_RUNTIME_STORE_LOCK_TIMEOUT",
        `Production Explore ${purpose} accounting lock timed out.`,
      );
    }
  }
}

async function fetchSharedLedgerEntries(connection: Pick<PostgresRuntimePool, "query">, schema: string, maxEntries: number): Promise<SharedLedgerEntry[]> {
  const qualified = `${quotePostgresIdentifier(schema)}.ledger_entries`;
  const result = await connection.query(`
    SELECT entry_key, kind, proposal_id, tenant_id, capability, payload_json, created_at::text AS created_at
    FROM ${qualified}
    ORDER BY entry_id ASC
    LIMIT $1
  `, [maxEntries + 1]);
  if (result.rows.length > maxEntries) {
    throw new ProposalStoreError("POSTGRES_RUNTIME_STORE_CAPACITY_EXCEEDED", `Postgres runtime store exceeds its configured ${maxEntries}-entry safety bound`);
  }
  return result.rows.map((row) => {
    const payload = parseJsonRecord(row.payload_json);
    return {
      entry_key: String(row.entry_key),
      kind: String(row.kind),
      proposal_id: row.proposal_id == null ? undefined : String(row.proposal_id),
      tenant_id: row.tenant_id == null ? undefined : String(row.tenant_id),
      capability: row.capability == null ? undefined : String(row.capability),
      payload,
      created_at: String(row.created_at),
    };
  });
}

async function upsertSharedLedgerEntries(connection: Pick<PostgresRuntimePool, "query">, schema: string, entries: SharedLedgerEntry[]): Promise<void> {
  const qualified = `${quotePostgresIdentifier(schema)}.ledger_entries`;
  for (const entry of entries) {
    assertNoSecretMaterial(entry.payload, `shared_ledger.${entry.kind}`);
    await connection.query(
      `INSERT INTO ${qualified} (entry_key, kind, proposal_id, tenant_id, capability, payload_json, created_at)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
ON CONFLICT (entry_key) DO UPDATE SET
  kind = EXCLUDED.kind,
  proposal_id = EXCLUDED.proposal_id,
  tenant_id = EXCLUDED.tenant_id,
  capability = EXCLUDED.capability,
  payload_json = EXCLUDED.payload_json,
  created_at = EXCLUDED.created_at`,
      [
        entry.entry_key,
        entry.kind,
        entry.proposal_id ?? null,
        entry.tenant_id ?? null,
        entry.capability ?? null,
        JSON.stringify(entry.payload),
        entry.created_at,
      ],
    );
  }
}

async function acquirePostgresRuntimeStoreLock(client: PostgresRuntimeClient, lockKey: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    const result = await client.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked", [lockKey]);
    if (result.rows[0]?.locked === true) return true;
    if (Date.now() - started >= timeoutMs) return false;
    await waitFor(Math.min(250, Math.max(25, timeoutMs - (Date.now() - started))));
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  const parsed = JSON.parse(String(value ?? "{}")) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function assertSafePostgresIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new ProposalStoreError("INVALID_POSTGRES_IDENTIFIER", `${label} must be a simple PostgreSQL identifier`);
  }
}

function quotePostgresIdentifier(value: string): string {
  assertSafePostgresIdentifier(value, "identifier");
  return `"${value.replace(/"/g, "\"\"")}"`;
}

async function waitFor(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
