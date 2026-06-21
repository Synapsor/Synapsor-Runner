import { DatabaseSync } from "node:sqlite";
import {
  parseChangeSet,
  parseExecutionReceipt,
  parseWritebackJob,
  protocolVersions,
  type ChangeSetV1,
  type ExecutionReceiptV1,
  type WritebackJob,
  type WritebackJobV1,
} from "@synapsor-runner/protocol";

export type LocalProposalState =
  | "pending_review"
  | "approved"
  | "rejected"
  | "canceled"
  | "pending_worker"
  | "applied"
  | "conflict"
  | "failed";

export type StoredProposal = {
  proposal_id: string;
  proposal_version: number;
  proposal_hash: string;
  action: string;
  state: LocalProposalState;
  tenant_id: string;
  business_object: string;
  object_id: string;
  source_kind: string;
  source_id: string;
  source_schema: string;
  source_table: string;
  source_database_mutated: boolean;
  change_set: ChangeSetV1;
  created_at: string;
  updated_at: string;
};

export type ProposalEvent = {
  event_id: number;
  proposal_id: string;
  kind: string;
  actor: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type StoredWritebackReceipt = {
  writeback_job_id: string;
  proposal_id: string;
  runner_id: string;
  status: string;
  idempotency_key: string;
  source_database_mutated: boolean;
  receipt: ExecutionReceiptV1;
  created_at: string;
};

export type ProposalReplayRecord = {
  replay_id: string;
  proposal: StoredProposal;
  events: ProposalEvent[];
  receipts: StoredWritebackReceipt[];
  query_audit: Record<string, unknown>[];
  evidence: Record<string, unknown>[];
  generated_at: string;
};

export type StoredEvidenceBundle = {
  evidence_bundle_id: string;
  proposal_id?: string;
  tenant_id: string;
  payload: Record<string, unknown>;
  items: Record<string, unknown>[];
  query_audit: Record<string, unknown>[];
  created_at: string;
};

export type CreateWritebackJobOptions = {
  project_id?: string;
  runner_id?: string;
  lease_seconds?: number;
  lease_id?: string;
};

export class ProposalStoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ProposalStoreError";
  }
}

export class ProposalStore {
  readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS proposal_store_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proposals (
        proposal_id TEXT PRIMARY KEY,
        proposal_version INTEGER NOT NULL,
        proposal_hash TEXT NOT NULL,
        action TEXT NOT NULL,
        state TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        business_object TEXT NOT NULL,
        object_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_schema TEXT NOT NULL,
        source_table TEXT NOT NULL,
        source_database_mutated INTEGER NOT NULL DEFAULT 0,
        change_set_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proposal_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS approvals (
        approval_id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id TEXT NOT NULL,
        proposal_version INTEGER NOT NULL,
        proposal_hash TEXT NOT NULL,
        approver TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS writeback_receipts (
        receipt_id INTEGER PRIMARY KEY AUTOINCREMENT,
        writeback_job_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        source_database_mutated INTEGER NOT NULL,
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (writeback_job_id, idempotency_key),
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS evidence_bundles (
        evidence_bundle_id TEXT PRIMARY KEY,
        proposal_id TEXT,
        tenant_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS evidence_items (
        evidence_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
        evidence_bundle_id TEXT NOT NULL,
        item_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (evidence_bundle_id) REFERENCES evidence_bundles(evidence_bundle_id)
      );

      CREATE TABLE IF NOT EXISTS query_audit (
        audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id TEXT,
        evidence_bundle_id TEXT,
        source_id TEXT NOT NULL,
        query_fingerprint TEXT NOT NULL,
        table_name TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id),
        FOREIGN KEY (evidence_bundle_id) REFERENCES evidence_bundles(evidence_bundle_id)
      );

      CREATE TABLE IF NOT EXISTS writeback_jobs (
        writeback_job_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        proposal_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        job_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS idempotency_receipts (
        idempotency_key TEXT PRIMARY KEY,
        writeback_job_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        receipt_status TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (writeback_job_id) REFERENCES writeback_jobs(writeback_job_id),
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS replay_records (
        replay_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
      );

      CREATE TABLE IF NOT EXISTS runner_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_proposal_events_proposal_id ON proposal_events(proposal_id);
      CREATE INDEX IF NOT EXISTS idx_query_audit_proposal_id ON query_audit(proposal_id);
      CREATE INDEX IF NOT EXISTS idx_writeback_receipts_proposal_id ON writeback_receipts(proposal_id);
      CREATE INDEX IF NOT EXISTS idx_replay_records_proposal_id ON replay_records(proposal_id);

      INSERT OR IGNORE INTO proposal_store_schema(version, applied_at)
      VALUES (1, datetime('now'));
    `);
  }

  createProposal(input: unknown): StoredProposal {
    const changeSet = parseChangeSet(input);
    const existing = this.getProposal(changeSet.proposal_id);
    if (existing) {
      if (
        existing.proposal_version !== changeSet.proposal_version ||
        existing.proposal_hash !== changeSet.integrity.proposal_hash
      ) {
        throw new ProposalStoreError(
          "PROPOSAL_IMMUTABILITY_VIOLATION",
          `proposal ${changeSet.proposal_id} already exists with a different version or hash`,
        );
      }
      return existing;
    }

    const state = stateFromChangeSet(changeSet);
    const now = changeSet.created_at || new Date().toISOString();
    const insert = this.db.prepare(`
      INSERT INTO proposals (
        proposal_id,
        proposal_version,
        proposal_hash,
        action,
        state,
        tenant_id,
        business_object,
        object_id,
        source_kind,
        source_id,
        source_schema,
        source_table,
        source_database_mutated,
        change_set_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.transaction(() => {
      insert.run(
        changeSet.proposal_id,
        changeSet.proposal_version,
        changeSet.integrity.proposal_hash,
        changeSet.action,
        state,
        changeSet.scope.tenant_id,
        changeSet.scope.business_object,
        changeSet.scope.object_id,
        changeSet.source.kind,
        changeSet.source.source_id,
        changeSet.source.schema,
        changeSet.source.table,
        changeSet.source_database_mutated ? 1 : 0,
        JSON.stringify(changeSet),
        now,
        now,
      );
      this.appendEvent(changeSet.proposal_id, "proposal_created", changeSet.principal.id, {
        proposal_hash: changeSet.integrity.proposal_hash,
        proposal_version: changeSet.proposal_version,
        source_database_mutated: changeSet.source_database_mutated,
      });
    });
    const created = this.getProposal(changeSet.proposal_id);
    if (!created) {
      throw new ProposalStoreError("PROPOSAL_CREATE_FAILED", `proposal ${changeSet.proposal_id} was not persisted`);
    }
    return created;
  }

  getProposal(proposalId: string): StoredProposal | undefined {
    const row = this.db.prepare("SELECT * FROM proposals WHERE proposal_id = ?").get(proposalId);
    return rowToProposal(row);
  }

  listProposals(state?: LocalProposalState): StoredProposal[] {
    const rows = state
      ? this.db.prepare("SELECT * FROM proposals WHERE state = ? ORDER BY created_at DESC").all(state)
      : this.db.prepare("SELECT * FROM proposals ORDER BY created_at DESC").all();
    return rows.map((row) => rowToProposal(row)).filter((proposal): proposal is StoredProposal => proposal !== undefined);
  }

  approveProposal(
    proposalId: string,
    options: { approver: string; proposal_hash: string; proposal_version: number; reason?: string },
  ): StoredProposal {
    const proposal = this.requireProposal(proposalId);
    assertWritebackAllowed(proposal, "approved");
    assertProposalIdentity(proposal, options.proposal_hash, options.proposal_version);
    if (proposal.state !== "pending_review") {
      throw new ProposalStoreError("PROPOSAL_NOT_PENDING_REVIEW", `proposal ${proposalId} is ${proposal.state}`);
    }
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run("approved", now, proposalId);
      this.db.prepare(`
        INSERT INTO approvals (proposal_id, proposal_version, proposal_hash, approver, status, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(proposalId, options.proposal_version, options.proposal_hash, options.approver, "approved", options.reason ?? null, now);
      this.appendEvent(proposalId, "proposal_approved", options.approver, {
        proposal_hash: options.proposal_hash,
        proposal_version: options.proposal_version,
        reason: options.reason ?? null,
      });
    });
    return this.requireProposal(proposalId);
  }

  rejectProposal(
    proposalId: string,
    options: { actor: string; proposal_hash: string; proposal_version: number; reason: string },
  ): StoredProposal {
    const proposal = this.requireProposal(proposalId);
    assertProposalIdentity(proposal, options.proposal_hash, options.proposal_version);
    if (proposal.state !== "pending_review" && proposal.state !== "approved") {
      throw new ProposalStoreError("PROPOSAL_NOT_REJECTABLE", `proposal ${proposalId} is ${proposal.state}`);
    }
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run("rejected", now, proposalId);
      this.db.prepare(`
        INSERT INTO approvals (proposal_id, proposal_version, proposal_hash, approver, status, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(proposalId, options.proposal_version, options.proposal_hash, options.actor, "rejected", options.reason, now);
      this.appendEvent(proposalId, "proposal_rejected", options.actor, {
        proposal_hash: options.proposal_hash,
        proposal_version: options.proposal_version,
        reason: options.reason,
      });
    });
    return this.requireProposal(proposalId);
  }

  markPendingWorker(proposalId: string, proposalHash: string, proposalVersion: number): StoredProposal {
    const proposal = this.requireProposal(proposalId);
    assertWritebackAllowed(proposal, "moved to pending worker");
    assertProposalIdentity(proposal, proposalHash, proposalVersion);
    if (proposal.state !== "approved") {
      throw new ProposalStoreError("PROPOSAL_NOT_APPROVED", `proposal ${proposalId} is ${proposal.state}`);
    }
    this.setState(proposalId, "pending_worker", "runner", { proposal_hash: proposalHash, proposal_version: proposalVersion });
    return this.requireProposal(proposalId);
  }

  recordExecutionReceipt(input: unknown): StoredProposal {
    const receipt = parseExecutionReceipt(input);
    const proposal = this.requireProposal(receipt.proposal_id);
    assertWritebackAllowed(proposal, "recorded with an execution receipt");
    const state = stateFromReceipt(receipt);
    const now = receipt.executed_at || new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO writeback_receipts (
          writeback_job_id,
          proposal_id,
          runner_id,
          status,
          idempotency_key,
          source_database_mutated,
          receipt_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receipt.writeback_job_id,
        receipt.proposal_id,
        receipt.runner_id,
        receipt.status,
        receipt.idempotency_key,
        receipt.source_database_mutated ? 1 : 0,
        JSON.stringify(receipt),
        now,
      );
      this.db.prepare("UPDATE proposals SET state = ?, source_database_mutated = ?, updated_at = ? WHERE proposal_id = ?")
        .run(state, receipt.source_database_mutated ? 1 : proposal.source_database_mutated ? 1 : 0, now, receipt.proposal_id);
      this.db.prepare(`
        INSERT OR REPLACE INTO idempotency_receipts (
          idempotency_key,
          writeback_job_id,
          proposal_id,
          receipt_status,
          receipt_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        receipt.idempotency_key,
        receipt.writeback_job_id,
        receipt.proposal_id,
        receipt.status,
        JSON.stringify(receipt),
        now,
      );
      this.db.prepare("UPDATE writeback_jobs SET status = ?, updated_at = ? WHERE writeback_job_id = ?")
        .run(receipt.status, now, receipt.writeback_job_id);
      this.appendEvent(receipt.proposal_id, `writeback_${receipt.status}`, receipt.runner_id, {
        writeback_job_id: receipt.writeback_job_id,
        rows_affected: receipt.rows_affected,
        source_database_mutated: receipt.source_database_mutated,
        receipt_hash: receipt.receipt_hash,
      });
    });
    return this.requireProposal(receipt.proposal_id);
  }

  recordWritebackJob(input: unknown): WritebackJob {
    const job = parseWritebackJob(input);
    const proposal = this.requireProposal(job.proposal_id);
    assertWritebackAllowed(proposal, "recorded with a writeback job");
    const proposalHash = job.approval_id;
    assertProposalIdentity(proposal, proposalHash, proposal.proposal_version);
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO writeback_jobs (
          writeback_job_id,
          proposal_id,
          proposal_hash,
          status,
          job_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(writeback_job_id) DO UPDATE SET
          status = excluded.status,
          job_json = excluded.job_json,
          updated_at = excluded.updated_at
      `).run(job.job_id, job.proposal_id, proposalHash, "pending_worker", JSON.stringify(job), now, now);
      this.appendEvent(job.proposal_id, "writeback_job_recorded", "runner", {
        writeback_job_id: job.job_id,
        proposal_hash: proposalHash,
        source_id: job.source_id,
      });
    });
    return job;
  }

  createWritebackJobFromProposal(proposalId: string, options: CreateWritebackJobOptions = {}): WritebackJobV1 {
    const proposal = this.requireProposal(proposalId);
    assertWritebackAllowed(proposal, "converted into a writeback job");
    if (proposal.state !== "approved" && proposal.state !== "pending_worker") {
      throw new ProposalStoreError("PROPOSAL_NOT_APPROVED", `proposal ${proposalId} is ${proposal.state}`);
    }
    const changeSet = proposal.change_set;
    if (changeSet.writeback.mode !== "trusted_worker_required") {
      throw new ProposalStoreError("WRITEBACK_NOT_REQUIRED", `proposal ${proposalId} uses ${changeSet.writeback.mode}`);
    }
    if (changeSet.source.kind !== "external_postgres" && changeSet.source.kind !== "external_mysql") {
      throw new ProposalStoreError("WRITEBACK_TARGET_NOT_EXTERNAL", `proposal ${proposalId} targets ${changeSet.source.kind}`);
    }
    const engine = changeSet.source.kind === "external_postgres" ? "postgres" : "mysql";
    const leaseSeconds = Math.max(15, Math.min(Number(options.lease_seconds ?? 300), 3600));
    const now = Date.now();
    const job: WritebackJobV1 = {
      schema_version: protocolVersions.writebackJob,
      writeback_job_id: `wbj_${proposal.proposal_id.replace(/[^A-Za-z0-9_:-]/g, "_")}`,
      proposal_id: proposal.proposal_id,
      proposal_version: proposal.proposal_version,
      proposal_hash: proposal.proposal_hash,
      runner_scope: {
        project_id: options.project_id ?? "local",
        source_id: proposal.source_id,
      },
      engine,
      operation: "single_row_update",
      target: {
        schema: proposal.source_schema,
        table: proposal.source_table,
        primary_key: changeSet.source.primary_key,
      },
      tenant_guard: changeSet.guards.tenant,
      allowed_columns: changeSet.guards.allowed_columns,
      patch: changeSet.patch,
      conflict_guard: conflictGuardFromChangeSet(changeSet),
      idempotency_key: `${proposal.proposal_id}:${proposal.object_id}`,
      lease: {
        lease_id: options.lease_id ?? `lease_${proposal.proposal_id.replace(/[^A-Za-z0-9_:-]/g, "_")}`,
        attempt: 1,
        expires_at: new Date(now + leaseSeconds * 1000).toISOString(),
      },
    };
    this.transaction(() => {
      if (proposal.state === "approved") {
        this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run("pending_worker", new Date().toISOString(), proposalId);
        this.appendEvent(proposalId, "proposal_pending_worker", options.runner_id ?? "local_runner", {
          proposal_hash: proposal.proposal_hash,
          proposal_version: proposal.proposal_version,
        });
      }
      const normalized = parseWritebackJob(job);
      this.db.prepare(`
        INSERT INTO writeback_jobs (
          writeback_job_id,
          proposal_id,
          proposal_hash,
          status,
          job_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(writeback_job_id) DO UPDATE SET
          status = excluded.status,
          job_json = excluded.job_json,
          updated_at = excluded.updated_at
      `).run(normalized.job_id, proposal.proposal_id, proposal.proposal_hash, "pending_worker", JSON.stringify(normalized), new Date().toISOString(), new Date().toISOString());
      this.appendEvent(proposal.proposal_id, "writeback_job_recorded", options.runner_id ?? "local_runner", {
        writeback_job_id: normalized.job_id,
        proposal_hash: proposal.proposal_hash,
        source_id: normalized.source_id,
      });
    });
    return job;
  }

  recordEvidenceBundle(input: {
    evidence_bundle_id: string;
    proposal_id?: string;
    tenant_id: string;
    payload: Record<string, unknown>;
    items?: Record<string, unknown>[];
  }): void {
    const now = new Date().toISOString();
    if (input.proposal_id) this.requireProposal(input.proposal_id);
    this.transaction(() => {
      this.db.prepare(`
        INSERT OR REPLACE INTO evidence_bundles (
          evidence_bundle_id,
          proposal_id,
          tenant_id,
          payload_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(input.evidence_bundle_id, input.proposal_id ?? null, input.tenant_id, JSON.stringify(input.payload), now);
      for (const item of input.items ?? []) {
        this.db.prepare(`
          INSERT INTO evidence_items (evidence_bundle_id, item_json, created_at)
          VALUES (?, ?, ?)
        `).run(input.evidence_bundle_id, JSON.stringify(item), now);
      }
      if (input.proposal_id) {
        this.appendEvent(input.proposal_id, "evidence_recorded", "runner", {
          evidence_bundle_id: input.evidence_bundle_id,
          item_count: input.items?.length ?? 0,
        });
      }
    });
  }

  recordQueryAudit(input: {
    proposal_id?: string;
    evidence_bundle_id?: string;
    source_id: string;
    query_fingerprint: string;
    table_name: string;
    row_count: number;
    payload: Record<string, unknown>;
  }): void {
    const now = new Date().toISOString();
    if (input.proposal_id) this.requireProposal(input.proposal_id);
    this.db.prepare(`
      INSERT INTO query_audit (
        proposal_id,
        evidence_bundle_id,
        source_id,
        query_fingerprint,
        table_name,
        row_count,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.proposal_id ?? null,
      input.evidence_bundle_id ?? null,
      input.source_id,
      input.query_fingerprint,
      input.table_name,
      input.row_count,
      JSON.stringify(input.payload),
      now,
    );
  }

  getEvidenceBundle(evidenceBundleId: string): StoredEvidenceBundle | undefined {
    const row = this.db
      .prepare("SELECT * FROM evidence_bundles WHERE evidence_bundle_id = ?")
      .get(evidenceBundleId);
    if (!isRecord(row)) return undefined;
    return {
      evidence_bundle_id: String(row.evidence_bundle_id),
      proposal_id: row.proposal_id == null ? undefined : String(row.proposal_id),
      tenant_id: String(row.tenant_id),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
      items: this.evidenceItems(evidenceBundleId),
      query_audit: this.queryAuditByEvidence(evidenceBundleId),
      created_at: String(row.created_at),
    };
  }

  events(proposalId: string): ProposalEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM proposal_events WHERE proposal_id = ? ORDER BY event_id ASC")
      .all(proposalId);
    return rows.map(rowToEvent).filter((event): event is ProposalEvent => event !== undefined);
  }

  receipts(proposalId: string): StoredWritebackReceipt[] {
    const rows = this.db
      .prepare("SELECT * FROM writeback_receipts WHERE proposal_id = ? ORDER BY receipt_id ASC")
      .all(proposalId);
    return rows.map(rowToReceipt).filter((receipt): receipt is StoredWritebackReceipt => receipt !== undefined);
  }

  replay(proposalId: string): ProposalReplayRecord {
    const proposal = this.requireProposal(proposalId);
    const replay: ProposalReplayRecord = {
      replay_id: `replay_${proposalId}`,
      proposal,
      events: this.events(proposalId),
      receipts: this.receipts(proposalId),
      query_audit: this.queryAudit(proposalId),
      evidence: this.evidence(proposalId),
      generated_at: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT OR REPLACE INTO replay_records (replay_id, proposal_id, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(replay.replay_id, proposalId, JSON.stringify(replay), replay.generated_at);
    return replay;
  }

  setRunnerState(key: string, value: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO runner_state (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), new Date().toISOString());
  }

  getRunnerState(key: string): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT value_json FROM runner_state WHERE key = ?").get(key);
    if (!isRecord(row)) return undefined;
    return JSON.parse(String(row.value_json)) as Record<string, unknown>;
  }

  private requireProposal(proposalId: string): StoredProposal {
    const proposal = this.getProposal(proposalId);
    if (!proposal) {
      throw new ProposalStoreError("PROPOSAL_NOT_FOUND", `proposal ${proposalId} not found`);
    }
    return proposal;
  }

  private setState(
    proposalId: string,
    state: LocalProposalState,
    actor: string,
    payload: Record<string, unknown>,
  ): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run(state, now, proposalId);
      this.appendEvent(proposalId, `proposal_${state}`, actor, payload);
    });
  }

  private appendEvent(
    proposalId: string,
    kind: string,
    actor: string,
    payload: Record<string, unknown>,
  ): void {
    this.db.prepare(`
      INSERT INTO proposal_events (proposal_id, kind, actor, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(proposalId, kind, actor, JSON.stringify(payload), new Date().toISOString());
  }

  private queryAudit(proposalId: string): Record<string, unknown>[] {
    const rows = this.db
      .prepare("SELECT * FROM query_audit WHERE proposal_id = ? ORDER BY audit_id ASC")
      .all(proposalId);
    const records: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      records.push({
        audit_id: Number(row.audit_id),
        proposal_id: row.proposal_id == null ? undefined : String(row.proposal_id),
        evidence_bundle_id: row.evidence_bundle_id == null ? undefined : String(row.evidence_bundle_id),
        source_id: String(row.source_id),
        query_fingerprint: String(row.query_fingerprint),
        table_name: String(row.table_name),
        row_count: Number(row.row_count),
        payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
        created_at: String(row.created_at),
      });
    }
    return records;
  }

  private queryAuditByEvidence(evidenceBundleId: string): Record<string, unknown>[] {
    const rows = this.db
      .prepare("SELECT * FROM query_audit WHERE evidence_bundle_id = ? ORDER BY audit_id ASC")
      .all(evidenceBundleId);
    return rows.map(rowToQueryAudit).filter((record): record is Record<string, unknown> => record !== undefined);
  }

  private evidence(proposalId: string): Record<string, unknown>[] {
    const rows = this.db
      .prepare("SELECT * FROM evidence_bundles WHERE proposal_id = ? ORDER BY created_at ASC")
      .all(proposalId);
    const records: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      records.push({
        evidence_bundle_id: String(row.evidence_bundle_id),
        proposal_id: row.proposal_id == null ? undefined : String(row.proposal_id),
        tenant_id: String(row.tenant_id),
        payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
        created_at: String(row.created_at),
      });
    }
    return records;
  }

  private evidenceItems(evidenceBundleId: string): Record<string, unknown>[] {
    const rows = this.db
      .prepare("SELECT * FROM evidence_items WHERE evidence_bundle_id = ? ORDER BY evidence_item_id ASC")
      .all(evidenceBundleId);
    const records: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      records.push({
        evidence_item_id: Number(row.evidence_item_id),
        evidence_bundle_id: String(evidenceBundleId),
        item: JSON.parse(String(row.item_json)) as Record<string, unknown>,
        created_at: String(row.created_at),
      });
    }
    return records;
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function stateFromChangeSet(changeSet: ChangeSetV1): LocalProposalState {
  if (changeSet.approval.status === "approved") return "approved";
  if (changeSet.approval.status === "rejected") return "rejected";
  if (changeSet.approval.status === "canceled") return "canceled";
  return "pending_review";
}

function stateFromReceipt(receipt: ExecutionReceiptV1): LocalProposalState {
  if (receipt.status === "applied" || receipt.status === "already_applied") return "applied";
  if (receipt.status === "conflict") return "conflict";
  if (receipt.status === "canceled") return "canceled";
  return "failed";
}

function conflictGuardFromChangeSet(changeSet: ChangeSetV1): WritebackJobV1["conflict_guard"] {
  const guard = changeSet.guards.expected_version;
  if (guard.column === "__row_hash") {
    return { kind: "row_hash", expected_hash: String(guard.value) };
  }
  if (!guard.column || guard.value === null || guard.value === undefined) {
    return { kind: "none" };
  }
  return { kind: "column", column: guard.column, expected_value: guard.value };
}

function assertProposalIdentity(proposal: StoredProposal, hash: string, version: number): void {
  if (proposal.proposal_hash !== hash) {
    throw new ProposalStoreError("PROPOSAL_HASH_MISMATCH", `proposal ${proposal.proposal_id} hash mismatch`);
  }
  if (proposal.proposal_version !== version) {
    throw new ProposalStoreError("PROPOSAL_VERSION_MISMATCH", `proposal ${proposal.proposal_id} version mismatch`);
  }
}

function assertWritebackAllowed(proposal: StoredProposal, operation: string): void {
  if (proposal.change_set.mode === "shadow") {
    throw new ProposalStoreError(
      "SHADOW_WRITEBACK_DISABLED",
      `shadow proposal ${proposal.proposal_id} cannot be ${operation}; shadow mode stores proposals, evidence, query audit, and replay only and never mutates the source database`,
    );
  }
  if (proposal.change_set.mode === "read_only") {
    throw new ProposalStoreError(
      "READ_ONLY_WRITEBACK_DISABLED",
      `read-only proposal ${proposal.proposal_id} cannot be ${operation}; read-only mode does not allow proposal writeback`,
    );
  }
}

function rowToProposal(row: unknown): StoredProposal | undefined {
  if (!isRecord(row)) return undefined;
  return {
    proposal_id: String(row.proposal_id),
    proposal_version: Number(row.proposal_version),
    proposal_hash: String(row.proposal_hash),
    action: String(row.action),
    state: String(row.state) as LocalProposalState,
    tenant_id: String(row.tenant_id),
    business_object: String(row.business_object),
    object_id: String(row.object_id),
    source_kind: String(row.source_kind),
    source_id: String(row.source_id),
    source_schema: String(row.source_schema),
    source_table: String(row.source_table),
    source_database_mutated: Number(row.source_database_mutated) === 1,
    change_set: parseChangeSet(JSON.parse(String(row.change_set_json))),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToEvent(row: unknown): ProposalEvent | undefined {
  if (!isRecord(row)) return undefined;
  return {
    event_id: Number(row.event_id),
    proposal_id: String(row.proposal_id),
    kind: String(row.kind),
    actor: String(row.actor),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    created_at: String(row.created_at),
  };
}

function rowToReceipt(row: unknown): StoredWritebackReceipt | undefined {
  if (!isRecord(row)) return undefined;
  return {
    writeback_job_id: String(row.writeback_job_id),
    proposal_id: String(row.proposal_id),
    runner_id: String(row.runner_id),
    status: String(row.status),
    idempotency_key: String(row.idempotency_key),
    source_database_mutated: Number(row.source_database_mutated) === 1,
    receipt: parseExecutionReceipt(JSON.parse(String(row.receipt_json))),
    created_at: String(row.created_at),
  };
}

function rowToQueryAudit(row: unknown): Record<string, unknown> | undefined {
  if (!isRecord(row)) return undefined;
  return {
    audit_id: Number(row.audit_id),
    proposal_id: row.proposal_id == null ? undefined : String(row.proposal_id),
    evidence_bundle_id: row.evidence_bundle_id == null ? undefined : String(row.evidence_bundle_id),
    source_id: String(row.source_id),
    query_fingerprint: String(row.query_fingerprint),
    table_name: String(row.table_name),
    row_count: Number(row.row_count),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    created_at: String(row.created_at),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
