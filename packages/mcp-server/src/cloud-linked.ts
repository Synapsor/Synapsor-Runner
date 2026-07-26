import crypto from "node:crypto";
import fs from "node:fs";
import {
  CloudControlError,
  ControlPlaneClient,
  type AdapterToolCatalogEntry,
} from "@synapsor-runner/control-plane-client";
import type {
  CloudOutboxItem,
  ProposalRuntimeStore,
  StoredProposal,
} from "@synapsor-runner/proposal-store";
import {
  canonicalJsonDigest,
  protocolVersions,
  type ChangeSet,
  type RunnerActivityV1,
  type RunnerProposalV1,
  type WritebackResult,
} from "@synapsor-runner/protocol";
import type {
  RuntimeConfig,
  CloudLinkedConnection,
  CloudLinkedSyncStatus,
  LocalToolMetadata,
  CloudAdapterClient,
} from "./runtime-types.js";
import {
  McpRuntimeError,
  safeRuntimeErrorCode,
} from "./runtime-errors.js";
import {
  envValue,
  isRecord,
  nonEmptyString,
} from "./safe-values.js";

export function loadCloudLinkedConnection(config: RuntimeConfig, env: NodeJS.ProcessEnv = process.env): CloudLinkedConnection {
  if (config.governance?.mode !== "cloud_linked") {
    throw new McpRuntimeError("CLOUD_LINKED_MODE_REQUIRED", "This operation requires governance.mode cloud_linked.");
  }
  const connectionPath = config.governance.connection_file;
  if (!connectionPath) throw new McpRuntimeError("CLOUD_CONNECTION_REQUIRED", "Cloud-linked governance requires governance.connection_file.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(connectionPath, "utf8"));
  } catch (error) {
    throw new McpRuntimeError("CLOUD_CONNECTION_INVALID", `Unable to read the reviewed Cloud connection file: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = isRecord(parsed) ? parsed : {};
  const cloud = isRecord(root.cloud) ? root.cloud : undefined;
  if (!cloud) throw new McpRuntimeError("CLOUD_CONNECTION_INVALID", "Cloud connection file must contain a cloud object.");
  const baseUrlEnv = nonEmptyString(cloud.base_url_env) ?? "SYNAPSOR_CLOUD_BASE_URL";
  const runnerTokenEnv = nonEmptyString(cloud.runner_token_env) ?? "SYNAPSOR_RUNNER_TOKEN";
  const baseUrl = envValue(env, baseUrlEnv) ?? nonEmptyString(cloud.base_url);
  const runnerToken = envValue(env, runnerTokenEnv);
  const sourceId = nonEmptyString(cloud.source_id);
  const runnerSourceId = nonEmptyString(cloud.runner_source_id) ?? sourceId;
  const projectId = nonEmptyString(cloud.project_id);
  const contractId = nonEmptyString(cloud.contract_id);
  const contractVersionId = nonEmptyString(cloud.contract_version_id);
  const digest = nonEmptyString(cloud.contract_digest);
  const missing = [
    !baseUrl ? baseUrlEnv : "",
    !runnerToken ? runnerTokenEnv : "",
    !projectId ? "cloud.project_id" : "",
    !sourceId ? "cloud.source_id" : "",
    !contractId ? "cloud.contract_id" : "",
    !contractVersionId ? "cloud.contract_version_id" : "",
    !digest ? "cloud.contract_digest" : "",
  ].filter(Boolean);
  if (missing.length) throw new McpRuntimeError("CLOUD_CONNECTION_INCOMPLETE", `Cloud-linked connection is missing: ${missing.join(", ")}.`);
  if (!/^sha256:[0-9a-f]{64}$/i.test(digest!)) throw new McpRuntimeError("CLOUD_CONTRACT_DIGEST_INVALID", "cloud.contract_digest must be a full sha256 digest.");
  let normalizedBaseUrl: string;
  try {
    const url = new URL(baseUrl!);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("unsafe URL components");
    normalizedBaseUrl = url.toString().replace(/\/$/, "");
  } catch {
    throw new McpRuntimeError("CLOUD_BASE_URL_INVALID", `${baseUrlEnv} must contain an HTTP(S) origin without credentials, query, or fragment.`);
  }
  return {
    protocol_version: nonEmptyString(cloud.protocol_version) ?? protocolVersions.runnerProposal,
    base_url: normalizedBaseUrl,
    runner_token_env: runnerTokenEnv,
    runner_token: runnerToken!,
    runner_id: nonEmptyString(cloud.runner_id) ?? envValue(env, "SYNAPSOR_RUNNER_ID") ?? "synapsor_runner_local",
    runner_version: nonEmptyString(cloud.runner_version) ?? envValue(env, "npm_package_version") ?? "unknown",
    project_id: projectId!,
    source_id: sourceId!,
    runner_source_id: runnerSourceId!,
    ...(nonEmptyString(cloud.mapping_id) ? { mapping_id: nonEmptyString(cloud.mapping_id) } : {}),
    contract_id: contractId!,
    contract_version_id: contractVersionId!,
    contract_digest: digest!.toLowerCase() as `sha256:${string}`,
  };
}

export async function enqueueCloudLinkedProposal(input: {
  config: RuntimeConfig;
  store: ProposalRuntimeStore;
  proposal: StoredProposal;
  evidenceBundleId: string;
  queryFingerprint: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CloudOutboxItem | undefined> {
  if (input.config.governance?.mode !== "cloud_linked") return undefined;
  if (!input.store.enqueueCloudOutbox) throw new McpRuntimeError("CLOUD_OUTBOX_UNAVAILABLE", "The configured runtime store does not implement the durable Cloud outbox.");
  const connection = loadCloudLinkedConnection(input.config, input.env ?? process.env);
  if (input.proposal.source_id !== connection.runner_source_id) {
    throw new McpRuntimeError("CLOUD_SOURCE_MAPPING_MISMATCH", `Proposal source ${input.proposal.source_id} is not the reviewed local source ${connection.runner_source_id}.`);
  }
  const evidence = input.store.listEvidenceBundles
    ? await input.store.listEvidenceBundles({ proposal: input.proposal.proposal_id, limit: 100 })
    : [];
  const queryAudit = input.store.listQueryAudit
    ? await input.store.listQueryAudit({ proposal: input.proposal.proposal_id, limit: 100 })
    : [];
  const sanitizedChangeSet = cloudSafeChangeSet(input.proposal.change_set);
  const proposalPayload: RunnerProposalV1 = {
    schema_version: protocolVersions.runnerProposal,
    runner_id: connection.runner_id,
    source_id: connection.source_id,
    ...(connection.mapping_id ? { mapping_id: connection.mapping_id } : {}),
    contract: {
      contract_id: connection.contract_id,
      contract_version_id: connection.contract_version_id,
      digest: connection.contract_digest,
    },
    change_set: sanitizedChangeSet,
    evidence_metadata: {
      bundle_ids: evidence.length ? evidence.map((item) => item.evidence_bundle_id) : [input.evidenceBundleId],
      count: evidence.length || 1,
      query_fingerprints: [...new Set([input.queryFingerprint, ...evidence.map((item) => item.query_fingerprint)].filter((value): value is string => Boolean(value)))],
      payload_uploaded: false,
    },
    query_audit: {
      audit_ids: queryAudit.map((item) => item.audit_id).filter((value) => value !== undefined) as Array<string | number>,
      count: queryAudit.length,
      query_fingerprints: [...new Set(queryAudit.map((item) => typeof item.query_fingerprint === "string" ? item.query_fingerprint : undefined).filter((value): value is string => Boolean(value)))],
      tables: [...new Set(queryAudit.map((item) => typeof item.table_name === "string" ? item.table_name : undefined).filter((value): value is string => Boolean(value)))],
      payload_uploaded: false,
    },
  };
  const maxAttempts = input.config.governance.max_attempts ?? 12;
  const proposalItem = await input.store.enqueueCloudOutbox({
    event_id: `cloud-proposal:${input.proposal.proposal_id}`,
    proposal_id: input.proposal.proposal_id,
    sequence: 0,
    kind: "proposal",
    payload: proposalPayload as unknown as Record<string, unknown>,
    max_attempts: maxAttempts,
  });
  const principalScope = input.proposal.change_set.guards.principal_scope;
  const common = {
    schema_version: protocolVersions.runnerActivity,
    runner_id: connection.runner_id,
    source_id: connection.source_id,
    proposal_id: input.proposal.proposal_id,
    capability: input.proposal.action,
    tenant_id: input.proposal.tenant_id,
    principal: principalScope?.value_fingerprint ?? input.proposal.principal,
    business_object: input.proposal.business_object,
    object_id: input.proposal.object_id,
    status: "pending_cloud_sync",
  } as const;
  for (const [index, bundle] of evidence.entries()) {
    const activity: RunnerActivityV1 = {
      ...common,
      event_id: `evidence:${input.proposal.proposal_id}:${bundle.evidence_bundle_id}`,
      event_type: "evidence.recorded",
      evidence_ids: [bundle.evidence_bundle_id],
      detail: { residency: "metadata_only", stored_locally: true, payload_uploaded: false },
      occurred_at: bundle.created_at,
    };
    await input.store.enqueueCloudOutbox({ event_id: `cloud-activity:${activity.event_id}`, proposal_id: input.proposal.proposal_id, sequence: 10 + index, kind: "activity", payload: activity as unknown as Record<string, unknown>, max_attempts: maxAttempts });
  }
  for (const [index, audit] of queryAudit.entries()) {
    const auditId = String(audit.audit_id);
    const activity: RunnerActivityV1 = {
      ...common,
      event_id: `query-audit:${input.proposal.proposal_id}:${auditId}`,
      event_type: "query_audit.recorded",
      query_audit_ids: [auditId],
      ...(typeof audit.evidence_bundle_id === "string" ? { evidence_ids: [audit.evidence_bundle_id] } : {}),
      detail: { residency: "metadata_only", stored_locally: true, payload_uploaded: false },
      occurred_at: typeof audit.created_at === "string" ? audit.created_at : undefined,
    };
    await input.store.enqueueCloudOutbox({ event_id: `cloud-activity:${activity.event_id}`, proposal_id: input.proposal.proposal_id, sequence: 20 + index, kind: "activity", payload: activity as unknown as Record<string, unknown>, max_attempts: maxAttempts });
  }
  await input.store.recordCloudGovernanceEvent?.({
    event_id: `cloud-governance:pending:${input.proposal.proposal_id}`,
    proposal_id: input.proposal.proposal_id,
    kind: "proposal.pending_cloud_sync",
    state: "pending_cloud_sync",
    payload: { evidence_residency: "metadata_only", contract_digest: connection.contract_digest, project_id: connection.project_id, source_id: connection.source_id },
  });
  return proposalItem;
}

export async function enqueueCloudLinkedResult(input: {
  config: RuntimeConfig;
  store: ProposalRuntimeStore;
  proposalId: string;
  result: WritebackResult;
  leaseId: string;
}): Promise<CloudOutboxItem | undefined> {
  if (input.config.governance?.mode !== "cloud_linked") return undefined;
  if (!input.store.enqueueCloudOutbox) throw new McpRuntimeError("CLOUD_OUTBOX_UNAVAILABLE", "The configured runtime store does not implement the durable Cloud outbox.");
  if (input.result.job_id !== `wbj_${input.proposalId}` && !input.result.job_id.endsWith(input.proposalId)) {
    throw new McpRuntimeError("CLOUD_RESULT_PROPOSAL_MISMATCH", "Cloud result job identity does not match the local proposal.");
  }
  const proposal = await input.store.getProposal(input.proposalId);
  const localAuthorityRejected = input.result.status === "failed"
    && input.result.affected_rows === 0
    && input.result.error_code === "LOCAL_AUTHORITY_REJECTED";
  if (!proposal && !localAuthorityRejected) {
    throw new McpRuntimeError("CLOUD_RESULT_LOCAL_PROPOSAL_REQUIRED", `Cloud result ${input.result.job_id} has no matching local proposal.`);
  }
  const payload = {
    schema_version: "synapsor.cloud-result-outbox.v1",
    lease_id: input.leaseId,
    result: input.result,
  };
  return input.store.enqueueCloudOutbox({
    event_id: `cloud-result:${input.result.job_id}:${input.result.result_hash}`,
    ...(proposal ? { proposal_id: input.proposalId } : {}),
    sequence: 1_000,
    kind: "result",
    payload,
    max_attempts: input.config.governance.max_attempts ?? 12,
  });
}

export async function assertCloudLinkedProposalAvailability(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (config.governance?.mode !== "cloud_linked" || config.governance.queue_when_unavailable !== false) return;
  const connection = loadCloudLinkedConnection(config, env);
  const client = new ControlPlaneClient({
    baseUrl: connection.base_url,
    runnerToken: connection.runner_token,
    sourceId: connection.source_id,
    runnerId: connection.runner_id,
  });
  let result: Awaited<ReturnType<ControlPlaneClient["doctor"]>>;
  try {
    result = await client.doctor();
  } catch (error) {
    throw new McpRuntimeError(
      "CLOUD_TEMPORARILY_UNAVAILABLE",
      "Synapsor Cloud is temporarily unavailable and this Runner is configured not to queue proposals.",
      { retry_after_ms: 1_000, cause_code: safeRuntimeErrorCode(error) },
    );
  }
  if (result.ok && result.authenticated) return;
  const errorCode = nonEmptyString(result.details?.error) ?? nonEmptyString(result.details?.error_code);
  if (result.status === 401) {
    throw new McpRuntimeError("CLOUD_RUNNER_AUTHENTICATION_FAILED", "The reviewed Synapsor Cloud Runner credential is not authenticated.");
  }
  if (result.status === 403) {
    throw new McpRuntimeError("CLOUD_RUNNER_AUTHORIZATION_FAILED", "The reviewed Synapsor Cloud Runner identity is not authorized for this source.");
  }
  if ([409, 412, 422].includes(result.status)) {
    throw new McpRuntimeError("CLOUD_CONNECTION_CONFLICT", "The reviewed local Cloud connection no longer matches the active Cloud contract or source.", {
      ...(errorCode ? { cloud_error_code: errorCode } : {}),
    });
  }
  if (result.status === 429) {
    throw new McpRuntimeError("CLOUD_RATE_LIMITED", "Synapsor Cloud is rate limiting proposal submissions.", { retry_after_ms: 1_000 });
  }
  throw new McpRuntimeError(
    "CLOUD_TEMPORARILY_UNAVAILABLE",
    "Synapsor Cloud is temporarily unavailable and this Runner is configured not to queue proposals.",
    { retry_after_ms: 1_000, cloud_status: result.status, ...(errorCode ? { cloud_error_code: errorCode } : {}) },
  );
}

export function cloudSafeChangeSet(changeSet: ChangeSet): ChangeSet {
  const sanitized = JSON.parse(JSON.stringify(changeSet)) as ChangeSet;
  sanitized.evidence.items = [];
  const principalScope = sanitized.guards.principal_scope;
  if (principalScope) {
    stripCloudPrincipalColumn(sanitized, principalScope.column);
    sanitized.principal.id = principalScope.value_fingerprint;
    delete principalScope.value;
  }
  return sanitized;
}

export function stripCloudPrincipalColumn(changeSet: ChangeSet, column: string): void {
  const strip = (value: unknown) => { if (isRecord(value)) delete value[column]; };
  strip(changeSet.before);
  strip(changeSet.after);
  if ("frozen_set" in changeSet && isRecord(changeSet.frozen_set) && Array.isArray(changeSet.frozen_set.members)) {
    for (const member of changeSet.frozen_set.members) {
      if (!isRecord(member)) continue;
      strip(member.before);
      strip(member.after);
    }
  }
  if (changeSet.schema_version === protocolVersions.compensationChangeSet) {
    for (const member of changeSet.compensation.descriptor.members) {
      strip(member.expected_state);
      strip(member.restore_values);
    }
  }
}

export class CloudLinkedSynchronizer {
  private readonly connection: CloudLinkedConnection;
  private readonly client: ControlPlaneClient;
  private readonly owner: string;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private activeDrain?: Promise<{ claimed: number; acknowledged: number; failed: number }>;
  private lastReconciledAt?: string;
  private lastReconciliationErrorCode?: string;
  private lastCompactedAt?: string;
  private lastCompactedCount = 0;

  constructor(private readonly config: RuntimeConfig, private readonly store: ProposalRuntimeStore, env: NodeJS.ProcessEnv = process.env) {
    this.connection = loadCloudLinkedConnection(config, env);
    this.client = new ControlPlaneClient({ baseUrl: this.connection.base_url, runnerToken: this.connection.runner_token, sourceId: this.connection.source_id, runnerId: this.connection.runner_id });
    this.owner = `${this.connection.runner_id}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;
    if (!store.claimCloudOutbox || !store.acknowledgeCloudOutbox || !store.failCloudOutbox || !store.listCloudOutbox) {
      throw new McpRuntimeError("CLOUD_OUTBOX_UNAVAILABLE", "Cloud-linked governance requires durable outbox support in the runtime store.");
    }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const tick = async () => {
      if (this.stopped) return;
      await this.drainOnce().catch(() => undefined);
      if (!this.stopped) {
        this.timer = setTimeout(tick, this.config.governance?.sync_interval_ms ?? 2_000);
        this.timer.unref?.();
      }
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.activeDrain?.catch(() => undefined);
  }

  async drainOnce(): Promise<{ claimed: number; acknowledged: number; failed: number }> {
    if (this.activeDrain) return this.activeDrain;
    const drain = this.performDrainOnce();
    this.activeDrain = drain;
    try {
      return await drain;
    } finally {
      if (this.activeDrain === drain) this.activeDrain = undefined;
    }
  }

  async synchronizeBeforeProposal(): Promise<void> {
    while (this.activeDrain) await this.activeDrain;
    await this.drainOnce();
  }

  async flushEvent(eventId: string, timeoutMs = 30_000): Promise<CloudOutboxItem> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      const current = (await this.store.listCloudOutbox!({ limit: 10_000 })).find((item) => item.event_id === eventId);
      if (!current) throw new McpRuntimeError("CLOUD_OUTBOX_EVENT_NOT_FOUND", `Cloud outbox event ${eventId} was not found.`);
      if (current.status === "acknowledged") return current;
      if (current.status === "dead_letter" || current.status === "reconciliation_required") {
        throw new McpRuntimeError(
          current.last_error_code ?? "CLOUD_OUTBOX_DELIVERY_FAILED",
          `Cloud outbox event ${eventId} requires operator attention (${current.status}).`,
        );
      }

      await this.drainOnce();
      const refreshed = (await this.store.listCloudOutbox!({ limit: 10_000 })).find((item) => item.event_id === eventId);
      if (!refreshed) throw new McpRuntimeError("CLOUD_OUTBOX_EVENT_NOT_FOUND", `Cloud outbox event ${eventId} was not found.`);
      if (refreshed.status === "acknowledged") return refreshed;
      if (refreshed.status === "dead_letter" || refreshed.status === "reconciliation_required") {
        throw new McpRuntimeError(
          refreshed.last_error_code ?? "CLOUD_OUTBOX_DELIVERY_FAILED",
          `Cloud outbox event ${eventId} requires operator attention (${refreshed.status}).`,
        );
      }
      if (Date.now() >= deadline) return refreshed;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
  }

  private async performDrainOnce(): Promise<{ claimed: number; acknowledged: number; failed: number }> {
    let acknowledged = 0;
    let failed = 0;
    const items = await this.store.claimCloudOutbox!({ owner: this.owner, limit: 10, lease_ms: 30_000 });
    for (const item of items) {
      try {
        const response = await this.deliver(item);
        if (item.proposal_id && item.kind === "proposal") {
          const cloudProposalId = nonEmptyString(response.proposal_id) ?? nonEmptyString(response.id) ?? item.proposal_id;
          const requestId = nonEmptyString(response.request_id);
          await this.store.recordCloudGovernanceEvent?.({
            event_id: `cloud-governance:ack:${item.event_id}`,
            proposal_id: item.proposal_id,
            cloud_proposal_id: cloudProposalId,
            kind: "proposal.cloud_acknowledged",
            state: nonEmptyString(response.status) ?? "pending_review",
            payload: { ...(requestId ? { request_id: requestId } : {}), evidence_residency: "metadata_only", payload_hash: item.payload_hash },
          });
        }
        await this.store.acknowledgeCloudOutbox!(item.event_id, this.owner);
        acknowledged += 1;
      } catch (error) {
        failed += 1;
        const classification = classifyCloudSyncFailure(error);
        await this.store.failCloudOutbox!({ event_id: item.event_id, owner: this.owner, ...classification });
      }
    }
    await this.reconcileOnce().catch((error) => {
      this.lastReconciliationErrorCode = classifyCloudSyncFailure(error).error_code;
    });
    await this.compactAcknowledged().catch(() => undefined);
    return { claimed: items.length, acknowledged, failed };
  }

  async status(): Promise<CloudLinkedSyncStatus> {
    const items = await this.store.listCloudOutbox!({ limit: 10_000 });
    const count = (status: CloudOutboxItem["status"]) => items.filter((item) => item.status === status).length;
    const pending = items.filter((item) => item.status === "pending");
    const acknowledged = items.filter((item) => item.status === "acknowledged" && item.acknowledged_at);
    return {
      authority_mode: "cloud_linked",
      evidence_residency: "metadata_only",
      pending: count("pending"),
      leased: count("leased"),
      acknowledged: count("acknowledged"),
      dead_letter: count("dead_letter"),
      reconciliation_required: count("reconciliation_required"),
      ...(pending[0] ? { oldest_pending_at: pending[0].created_at } : {}),
      ...(acknowledged.length ? { last_acknowledged_at: acknowledged.map((item) => item.acknowledged_at!).sort().at(-1) } : {}),
      ...(this.lastReconciledAt ? { last_reconciled_at: this.lastReconciledAt } : {}),
      ...(this.lastReconciliationErrorCode ? { last_reconciliation_error_code: this.lastReconciliationErrorCode } : {}),
      ...(this.lastCompactedAt ? { last_compacted_at: this.lastCompactedAt, last_compacted_count: this.lastCompactedCount } : {}),
    };
  }

  private async compactAcknowledged(): Promise<void> {
    if (!this.store.compactCloudOutbox) return;
    const now = Date.now();
    if (this.lastCompactedAt && now - Date.parse(this.lastCompactedAt) < 60 * 60 * 1_000) return;
    const retentionDays = this.config.governance?.outbox_retention_days ?? 30;
    const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1_000).toISOString();
    this.lastCompactedCount = await this.store.compactCloudOutbox({ acknowledged_before: cutoff });
    this.lastCompactedAt = new Date(now).toISOString();
  }

  async reconcileOnce(): Promise<{ inspected: number; recorded: number }> {
    if (!this.store.listCloudGovernanceEvents || !this.store.recordCloudGovernanceEvent) return { inspected: 0, recorded: 0 };
    const acknowledged = (await this.store.listCloudOutbox!({ status: "acknowledged", limit: 10_000 }))
      .filter((item) => item.kind === "proposal" && item.proposal_id);
    let recorded = 0;
    for (const item of acknowledged.slice(-100)) {
      const proposalId = item.proposal_id!;
      const events = await this.store.listCloudGovernanceEvents(proposalId);
      const latest = events.at(-1);
      if (latest && ["applied", "failed", "conflict", "indeterminate", "canceled", "rejected"].includes(latest.state)) continue;
      const response = await this.client.proposalStatus(proposalId);
      const state = nonEmptyString(response.status) ?? "unknown";
      const payload = cloudGovernanceStatusPayload(response);
      const identity = canonicalJsonDigest({ proposal_id: proposalId, state, payload });
      const eventId = `cloud-governance:state:${proposalId}:${identity.slice("sha256:".length, "sha256:".length + 20)}`;
      const existed = events.some((event) => event.event_id === eventId);
      await this.store.recordCloudGovernanceEvent({
        event_id: eventId,
        proposal_id: proposalId,
        cloud_proposal_id: nonEmptyString(response.proposal_id) ?? proposalId,
        kind: `proposal.cloud_${state}`,
        state,
        payload,
      });
      if (!existed) recorded += 1;
    }
    this.lastReconciledAt = new Date().toISOString();
    this.lastReconciliationErrorCode = undefined;
    return { inspected: acknowledged.length, recorded };
  }

  private async deliver(item: CloudOutboxItem): Promise<Record<string, unknown>> {
    if (item.kind === "proposal") return this.client.submitProposal(item.payload as unknown as RunnerProposalV1);
    if (item.kind === "activity") return this.client.submitActivity(item.payload as unknown as RunnerActivityV1);
    if (item.kind === "result") {
      const result = isRecord(item.payload.result) ? item.payload.result as unknown as WritebackResult : undefined;
      const leaseId = nonEmptyString(item.payload.lease_id);
      if (!result || !leaseId) throw new McpRuntimeError("CLOUD_RESULT_OUTBOX_INVALID", "Cloud result outbox entry is missing a result or lease identity.");
      return this.client.result(result, leaseId);
    }
    throw new McpRuntimeError("CLOUD_OUTBOX_KIND_UNSUPPORTED", `Unsupported Cloud outbox kind: ${item.kind}`);
  }
}

export function cloudGovernanceStatusPayload(response: Record<string, unknown>): Record<string, unknown> {
  const decision = isRecord(response.decision) ? response.decision : undefined;
  const job = isRecord(response.job) ? response.job : undefined;
  const result = isRecord(response.result) ? response.result : undefined;
  const actor = nonEmptyString(decision?.actor);
  return JSON.parse(JSON.stringify({
    contract_id: nonEmptyString(response.contract_id),
    contract_version_id: nonEmptyString(response.contract_version_id),
    contract_digest: nonEmptyString(response.contract_digest),
    source_id: nonEmptyString(response.source_id),
    terminal: response.terminal === true,
    evidence_residency: "metadata_only",
    decision: decision ? {
      status: nonEmptyString(decision.status),
      authority: "synapsor_cloud",
      actor_fingerprint: actor ? canonicalJsonDigest({ actor }) : undefined,
      decided_at: nonEmptyString(decision.decided_at),
    } : undefined,
    job: job ? {
      job_id: nonEmptyString(job.job_id),
      status: nonEmptyString(job.status),
      attempt_count: typeof job.attempt_count === "number" ? job.attempt_count : undefined,
      leased_runner_id: nonEmptyString(job.leased_runner_id),
      lease_expires_at: job.lease_expires_at,
    } : undefined,
    result: result ? {
      status: nonEmptyString(result.status),
      source_database_mutated: result.source_database_mutated === true,
      affected_rows: typeof result.affected_rows === "number" ? result.affected_rows : undefined,
      receipt_id: nonEmptyString(result.receipt_id),
      result_hash: nonEmptyString(result.result_hash),
      error_code: nonEmptyString(result.error_code),
    } : undefined,
    updated_at: response.updated_at,
  })) as Record<string, unknown>;
}

export function classifyCloudSyncFailure(error: unknown): { error_code: string; retryable: boolean; retry_after_ms?: number; reconciliation?: boolean } {
  if (error instanceof CloudControlError) {
    const reconciliation = [409, 412, 422].includes(error.status) || ["contract_digest_mismatch", "proposal_hash_mismatch", "cloud_state_conflict"].includes(error.error_code);
    return {
      error_code: error.error_code,
      retryable: error.retryable && !reconciliation,
      ...(error.retry_after_ms === undefined ? {} : { retry_after_ms: error.retry_after_ms }),
      ...(reconciliation ? { reconciliation: true } : {}),
    };
  }
  if (error instanceof McpRuntimeError) return { error_code: error.code, retryable: false };
  return { error_code: "cloud_sync_internal", retryable: false };
}

export function createCloudClient(config: RuntimeConfig, env: NodeJS.ProcessEnv): ControlPlaneClient {
  const cloud = requireCloudConfig(config);
  const baseUrl = envValue(env, cloud.base_url_env);
  const runnerToken = envValue(env, cloud.runner_token_env);
  if (!baseUrl) throw new McpRuntimeError("CLOUD_BASE_URL_MISSING", `${cloud.base_url_env} is not set.`);
  if (!runnerToken) throw new McpRuntimeError("CLOUD_RUNNER_TOKEN_MISSING", `${cloud.runner_token_env} is not set.`);
  return new ControlPlaneClient({
    baseUrl,
    runnerToken,
    sourceId: cloud.source_id,
  });
}

export async function fetchCloudToolMetadata(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  client: CloudAdapterClient = createCloudClient(config, env),
): Promise<LocalToolMetadata[]> {
  const cloud = requireCloudConfig(config);
  const catalog = await client.adapterTools(cloud.adapter_id, { session: cloud.session ?? {} });
  return catalog.tools.map((tool) => cloudToolMetadata(tool));
}

export async function callCloudTool(
  config: RuntimeConfig,
  client: CloudAdapterClient | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const cloud = requireCloudConfig(config);
  if (!client) throw new McpRuntimeError("CLOUD_CLIENT_UNAVAILABLE", "Cloud mode requires a configured Synapsor Cloud client.");
  const result = await client.callAdapterTool(cloud.adapter_id, name, args, {
    session: cloud.session ?? {},
  });
  return {
    mode: "cloud",
    adapter_id: cloud.adapter_id,
    tool_name: name,
    source_database_mutated: false,
    ...result.response,
  };
}

export function requireCloudConfig(config: RuntimeConfig): NonNullable<RuntimeConfig["cloud"]> {
  if (!config.cloud) {
    throw new McpRuntimeError("CLOUD_CONFIG_REQUIRED", "cloud mode requires a cloud config block.");
  }
  return config.cloud;
}

export function cloudToolMetadata(tool: AdapterToolCatalogEntry): LocalToolMetadata {
  return {
    name: tool.name,
    title: tool.title ?? tool.name,
    description: tool.description ?? "Synapsor Cloud-reviewed MCP database capability.",
    kind: tool.annotations?.readOnlyHint === true ? "read" : "proposal",
    input_schema: tool.input_schema ?? { type: "object", properties: {} },
    annotations: {
      ...tool.annotations,
      raw_sql_exposed: false,
      approval_or_commit_tool: false,
    },
  };
}
