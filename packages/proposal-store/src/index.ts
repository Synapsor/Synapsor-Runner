import { DatabaseSync } from "node:sqlite";
import {
  parseChangeSet,
  parseExecutionReceipt,
  type ChangeSetV1,
  type ExecutionReceiptV1,
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
      this.appendEvent(receipt.proposal_id, `writeback_${receipt.status}`, receipt.runner_id, {
        writeback_job_id: receipt.writeback_job_id,
        rows_affected: receipt.rows_affected,
        source_database_mutated: receipt.source_database_mutated,
        receipt_hash: receipt.receipt_hash,
      });
    });
    return this.requireProposal(receipt.proposal_id);
  }

  events(proposalId: string): ProposalEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM proposal_events WHERE proposal_id = ? ORDER BY event_id ASC")
      .all(proposalId);
    return rows.map(rowToEvent).filter((event): event is ProposalEvent => event !== undefined);
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

function assertProposalIdentity(proposal: StoredProposal, hash: string, version: number): void {
  if (proposal.proposal_hash !== hash) {
    throw new ProposalStoreError("PROPOSAL_HASH_MISMATCH", `proposal ${proposal.proposal_id} hash mismatch`);
  }
  if (proposal.proposal_version !== version) {
    throw new ProposalStoreError("PROPOSAL_VERSION_MISMATCH", `proposal ${proposal.proposal_id} version mismatch`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
